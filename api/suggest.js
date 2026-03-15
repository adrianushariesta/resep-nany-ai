export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { ingredients } = body;

    if (!ingredients) return res.status(400).json({ error: 'No ingredients provided' });

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const NOTION_DB_ID = process.env.NOTION_DB_ID;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

    if (!NOTION_TOKEN || !ANTHROPIC_KEY) {
      return res.status(500).json({ error: 'Missing environment variables' });
    }

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

    if (!notionRes.ok) {
      return res.status(500).json({ error: `Notion error: ${notionData.message}` });
    }

    const recipes = notionData.results || [];
    const top = recipes.slice(0, 4);

    for (const r of top) {
      const blockRes = await fetch(`https://api.notion.com/v1/blocks/${r.id}/children`, {
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28'
        }
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

    const recipeTexts = top.length > 0
      ? top.map((r, i) => {
          const name = r.properties['Nama Resep']?.title?.[0]?.plain_text || 'Resep';
          const bahan = (r.properties['Bahan Utama']?.multi_select || []).map(b => b.name).join(', ');
          const catatan = r.properties['Catatan']?.rich_text?.[0]?.plain_text || '';
          return `--- RESEP ${i+1}: ${name} ---\nBahan Utama: ${bahan}\n${r._content}${catatan ? '\nCatatan: ' + catatan : ''}`;
        }).join('\n\n')
      : 'Tidak ada resep yang cocok ditemukan di database.';

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
          content: 
            `Kamu adalah asisten dapur yang membantu pengguna menemukan resep dari koleksi resep Nany.

            Pengguna memiliki bahan-bahan berikut: ${ingredients}

            Berikut adalah resep-resep yang TERSEDIA di database Nany:
            ${recipeTexts}

            ATURAN PENTING:
            1. HANYA sarankan resep yang ada di daftar di atas — jangan mengarang atau menyebut resep yang tidak ada
            2. Jika tidak ada resep yang cocok, katakan dengan jujur bahwa koleksi Nany belum memiliki resep untuk bahan tersebut
            3. Jangan berpura-pura menjadi Nany — kamu adalah asisten yang membantu menemukan resep dari koleksinya
            4. Untuk setiap resep yang disarankan, sebutkan bahan yang sudah dimiliki pengguna dan bahan tambahan yang diperlukan
            5. Sampaikan tips dari Nany jika ada di dalam resep (dari bagian Catatan)

            Format jawaban dengan markdown (## untuk nama resep, bullet untuk bahan).`
        }]
      })
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      return res.status(500).json({ error: `Claude error: ${claudeData.error?.message}` });
    }

    return res.status(200).json({
      suggestion: claudeData.content[0].text,
      count: top.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}