export default async function handler(req, res) {
  if (typeof req.body === 'string') req.body = JSON.parse(req.body);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ingredients } = req.body;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

  try {
    const ingredientList = ingredients.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);

    const notionRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filter: {
          and: [
            { property: "Status", select: { equals: "Terverifikasi" } },
            { or: ingredientList.map(ing => ({ property: "Bahan Utama", multi_select: { contains: ing } })) }
          ]
        },
        page_size: 6
      })
    });

    const notionData = await notionRes.json();
    const recipes = notionData.results || [];

    const top = recipes.slice(0, 4);
    for (const r of top) {
      const blockRes = await fetch(`https://api.notion.com/v1/blocks/${r.id}/children`, {
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
      });
      const blockData = await blockRes.json();
      r._content = (blockData.results || []).map(b => {
        const type = b.type;
        const text = (b[type]?.rich_text || []).map(x => x.plain_text).join('');
        if (type.startsWith('heading')) return `\n## ${text}`;
        if (type === 'bulleted_list_item') return `- ${text}`;
        if (type === 'numbered_list_item') return `${text}`;
        return text;
      }).join('\n').trim();
    }

    const recipeTexts = top.map((r, i) => {
      const name = r.properties['Nama Resep']?.title?.[0]?.plain_text || 'Resep';
      const bahan = (r.properties['Bahan Utama']?.multi_select || []).map(b => b.name).join(', ');
      const catatan = r.properties['Catatan']?.rich_text?.[0]?.plain_text || '';
      return `--- RESEP ${i+1}: ${name} ---\nBahan Utama: ${bahan}\n${r._content}${catatan ? '\nCatatan: ' + catatan : ''}`;
    }).join('\n\n');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Kamu adalah asist