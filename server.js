const express = require('express'), crypto = require('crypto'), path = require('path');
const { createClient } = require('@supabase/supabase-js');
const E = process.env;
const GID = E.GOOGLE_CLIENT_ID || '372392007476-53d1cll8jk0jpj0bvrkv5bouc4rnn54c.apps.googleusercontent.com';
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SECRET_KEY);
const SEC = E.SESSION_SECRET || E.ADMIN_PASSWORD || 'troque-isto';
const app = express();
app.use(express.json());
const file = f => (q, r) => r.sendFile(path.join(__dirname, f));
app.get('/', file('index.html'));
app.get('/admin', file('admin.html'));

const hm = b => crypto.createHmac('sha256', SEC).update(b).digest('base64url');
const sign = o => { const b = Buffer.from(JSON.stringify({ ...o, exp: Date.now() + 2592e6 })).toString('base64url'); return b + '.' + hm(b); };
const verify = t => { try { const [b, s] = t.split('.'); if (s !== hm(b)) return null; const o = JSON.parse(Buffer.from(b, 'base64url')); return o.exp > Date.now() ? o : null; } catch { return null; } };
const auth = (q, r, n) => { const u = verify((q.headers.authorization || '').slice(7)); if (!u) return r.status(401).json({ error: 'Faça login com o Google' }); q.user = u; n(); };
const sha = s => crypto.createHash('sha256').update(s).digest();
const adm = (q, r, n) => { if (!E.ADMIN_PASSWORD || !crypto.timingSafeEqual(sha(q.headers['x-admin'] || ''), sha(E.ADMIN_PASSWORD))) return r.status(401).json({ error: 'Senha inválida' }); n(); };
const getSet = async () => { const { data } = await sb.from('settings').select('*'); return Object.fromEntries((data || []).map(x => [x.k, x.v])); };
const stockMap = async () => { const { data } = await sb.from('keys').select('plan_id').eq('used', false).limit(100000); const c = {}; (data || []).forEach(k => c[k.plan_id] = (c[k.plan_id] || 0) + 1); return c; };

app.get('/api/store', async (q, r) => {
  const s = await getSet(), c = await stockMap();
  const { data: pl } = await sb.from('plans').select('*').order('price');
  r.json({ gid: GID, name: s.name, desc: s.desc, image: s.image, whatsapp: s.whatsapp, youtube: s.youtube, logo: s.logo, soldout: s.soldout === 'true', plans: (pl || []).map(p => ({ ...p, stock: c[p.id] || 0 })) });
});

app.post('/api/login', async (q, r) => {
  try {
    const j = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(q.body.credential))).json();
    if (j.aud !== GID || !j.email) throw 0;
    const u = { email: j.email, name: j.name, pic: j.picture };
    r.json({ token: sign(u), user: u });
  } catch { r.status(401).json({ error: 'Login inválido' }); }
});

app.post('/api/buy', auth, async (q, r) => {
  const s = await getSet();
  const fn = String(q.body.first_name || '').trim().slice(0, 60), ln = String(q.body.last_name || '').trim().slice(0, 60), em = String(q.body.payer_email || '').trim().slice(0, 120);
  if (fn.length < 2 || ln.length < 2) return r.status(400).json({ error: 'Informe nome e sobrenome' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return r.status(400).json({ error: 'Informe um e-mail válido' });
  if (s.soldout === 'true') return r.status(400).json({ error: 'Produto esgotado, em atualização' });
  if (!E.MP_ACCESS_TOKEN) return r.status(503).json({ error: 'Pagamento ainda não configurado' });
  const { data: p } = await sb.from('plans').select('*').eq('id', q.body.plan_id).single();
  if (!p) return r.status(404).json({ error: 'Plano não encontrado' });
  const { count } = await sb.from('keys').select('id', { count: 'exact', head: true }).eq('plan_id', p.id).eq('used', false);
  if (!count) return r.status(400).json({ error: 'Sem estoque neste plano' });
  const id = crypto.randomUUID();
  const m = await (await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Idempotency-Key': id },
    body: JSON.stringify({ transaction_amount: Number(p.price), description: (s.name || 'CYBER MENU') + ' - ' + p.name, payment_method_id: 'pix', payer: { email: em, first_name: fn, last_name: ln }, external_reference: id })
  })).json();
  const t = m.point_of_interaction && m.point_of_interaction.transaction_data;
  if (!t) return r.status(502).json({ error: 'Não foi possível gerar o PIX', detail: m.message });
  const base = { id, email: q.user.email, plan_id: p.id, plan_name: p.name, amount: p.price, mp_id: String(m.id), status: 'pending' };
  let ins = await sb.from('orders').insert({ ...base, payer_email: em, payer_name: fn, mailed: false });
  if (ins.error) ins = await sb.from('orders').insert(base);
  if (ins.error) { console.error('order:', ins.error); return r.status(500).json({ error: 'Banco: ' + ins.error.message }); }
  r.json({ id, qr: t.qr_code, qr64: t.qr_code_base64, amount: p.price });
});

const he = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendMail(o, s) {
  if (!E.BREVO_API_KEY || !E.MAIL_FROM) return false;
  const brand = 'CYBER ONLINE', prod = (s.name || 'CYBER MENU') + ' - ' + o.plan_name;
  const price = 'R$' + Number(o.amount).toFixed(2), site = E.SITE_URL || E.RENDER_EXTERNAL_URL || '';
  const img = /^https?:\/\//i.test(s.image || '') ? `<img src="${he(s.image)}" alt="" width="100%" style="display:block;width:100%;max-height:220px;object-fit:cover;border-radius:16px 16px 0 0">` : '';
  const logoHtml = /^https?:\/\//i.test(s.logo || '') && !/\.(mp4|webm)(\?|$)/i.test(s.logo)
    ? `<img src="${he(s.logo)}" alt="" width="84" height="84" style="display:block;margin:0 auto;width:84px;height:84px;object-fit:cover;border-radius:18px;border:2px solid #4a1015">`
    : '<span style="display:inline-block;background:#2a0b0f;border:2px solid #4a1015;border-radius:16px;padding:16px 20px;font-size:24px;font-weight:bold;font-style:italic;color:#fff">CO</span>';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td align="center" style="padding:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0b0b0d;border-radius:18px;font-family:Arial,Helvetica,sans-serif;color:#f4f4f5">
<tr><td align="center" style="background:#1c1c1f;border-top:4px solid #dc2626;border-radius:18px 18px 0 0;padding:34px 20px">${logoHtml}<div style="margin-top:10px;font-size:13px;letter-spacing:3px;color:#a1a1aa">${he(brand)}</div></td></tr>
<tr><td style="padding:34px 28px 8px">
<div style="font-size:13px;letter-spacing:4px;color:#dc2626;font-weight:bold">PAGAMENTO APROVADO</div>
<div style="font-size:28px;font-weight:bold;margin:14px 0 14px;line-height:1.2">Sua compra foi confirmada!</div>
<div style="font-size:16px;line-height:1.6;color:#a1a1aa">Fala, <b style="color:#fff">${he(o.payer_name || 'cliente')}</b>! Tudo certo por aqui — seu pedido de <b style="color:#dc2626">${he(price)}</b> foi aprovado com sucesso.</div>
</td></tr>
<tr><td style="padding:26px 28px 6px"><div style="font-size:13px;letter-spacing:4px;color:#dc2626;font-weight:bold">SEU PEDIDO</div></td></tr>
<tr><td align="center" style="padding:10px 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:380px;background:#17171a;border-radius:16px"><tr><td style="padding:0">${img}</td></tr>
<tr><td style="padding:16px 18px 18px"><div style="font-size:15px;font-weight:bold;line-height:1.4">${he(prod)}</div><div style="font-size:18px;font-weight:bold;color:#dc2626;margin-top:8px">${he(price)}</div><div style="font-size:13px;color:#8a8a93;margin-top:6px">À vista no Pix</div></td></tr></table></td></tr>
<tr><td style="padding:26px 28px 6px"><div style="font-size:13px;letter-spacing:4px;color:#dc2626;font-weight:bold">ESTOQUE ENTREGUE</div></td></tr>
<tr><td style="padding:10px 28px 6px"><div style="background:#252528;border-radius:14px;padding:18px"><div style="font-size:15px;font-weight:bold;margin-bottom:10px">${he(prod)}</div><div style="font-family:Consolas,Menlo,monospace;font-size:14px;line-height:1.6;color:#d4d4d8;word-break:break-all">KEY DE ACESSO: ${he(o.key)}</div></div></td></tr>
${site ? `<tr><td style="padding:22px 28px 6px"><a href="${he(site)}" style="display:block;text-align:center;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:16px;border-radius:14px">Resgatar pedido(s)</a></td></tr>` : ''}
<tr><td align="center" style="padding:26px 28px 20px;font-size:13px;color:#6b6b73">Se você não reconhece essa compra, ignore este e-mail.</td></tr>
<tr><td align="center" style="border-top:1px solid #1f1f23;padding:18px 28px 24px;font-size:13px;color:#dc2626">E-mail enviado por ${he(site || brand)}</td></tr>
</table></td></tr></table></body></html>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': E.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: brand, email: E.MAIL_FROM }, to: [{ email: o.payer_email, name: o.payer_name || undefined }], subject: 'Pagamento aprovado • ' + brand, htmlContent: html })
  });
  if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + await r.text());
  return true;
}

const busy = new Set();
async function check(o) {
  if (busy.has(o.id)) return o;
  busy.add(o.id);
  try {
    if (o.status === 'pending') {
      const m = await (await fetch('https://api.mercadopago.com/v1/payments/' + o.mp_id, { headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN } })).json();
      if (m.status === 'approved') { await sb.from('orders').update({ status: 'paid' }).eq('id', o.id); o.status = 'paid'; }
      else if (['cancelled', 'rejected', 'expired'].includes(m.status)) { await sb.from('orders').update({ status: 'failed' }).eq('id', o.id); o.status = 'failed'; }
    }
    if (o.status === 'paid' && !o.key) {
      for (let i = 0; i < 5 && !o.key; i++) {
        const { data: k } = await sb.from('keys').select('id,key').eq('plan_id', o.plan_id).eq('used', false).limit(1);
        if (!k || !k.length) break;
        const { data: u } = await sb.from('keys').update({ used: true, order_id: o.id }).eq('id', k[0].id).eq('used', false).select();
        if (u && u.length) { o.key = u[0].key; await sb.from('orders').update({ key: o.key }).eq('id', o.id); }
      }
    }
    if (o.status === 'paid' && o.key && o.payer_email && o.mailed === false) {
      try { if (await sendMail(o, await getSet())) { await sb.from('orders').update({ mailed: true }).eq('id', o.id); o.mailed = true; } }
      catch (e) { console.error('mail:', e.message); }
    }
  } finally { busy.delete(o.id); }
  return o;
}
const pub = (o, s) => ({ id: o.id, status: o.status, plan: o.plan_name, key: o.key, apk: o.key ? s.apk : null, date: o.created_at });

app.get('/api/order/:id', auth, async (q, r) => {
  const { data: o } = await sb.from('orders').select('*').eq('id', q.params.id).eq('email', q.user.email).single();
  if (!o) return r.sendStatus(404);
  r.json(pub(await check(o), await getSet()));
});
app.get('/api/orders', auth, async (q, r) => {
  const { data } = await sb.from('orders').select('*').eq('email', q.user.email).order('created_at', { ascending: false }).limit(30);
  const s = await getSet(), out = [];
  for (const o of data || []) {
    if (E.MP_ACCESS_TOKEN && (o.status === 'pending' || (o.status === 'paid' && !o.key))) { try { await check(o); } catch {} }
    out.push(pub(o, s));
  }
  r.json(out);
});

/* ---- ADMIN ---- */
app.get('/api/admin/data', adm, async (q, r) => {
  const s = await getSet(), c = await stockMap();
  const { data: pl } = await sb.from('plans').select('*').order('price');
  const { data: od } = await sb.from('orders').select('email,plan_name,amount,status,created_at').order('created_at', { ascending: false }).limit(30);
  r.json({ s, plans: (pl || []).map(p => ({ ...p, stock: c[p.id] || 0 })), orders: od || [] });
});
app.post('/api/admin/settings', adm, async (q, r) => {
  const ok = ['name', 'desc', 'image', 'logo', 'whatsapp', 'youtube', 'apk', 'soldout'];
  const rows = Object.entries(q.body).filter(([k]) => ok.includes(k)).map(([k, v]) => ({ k, v: String(v) }));
  const x = await sb.from('settings').upsert(rows, { onConflict: 'k' });
  if (x.error) { console.error('settings:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true });
});
app.post('/api/admin/plan', adm, async (q, r) => {
  const { id, name, price } = q.body, row = { name, price: Number(price) };
  if (!name || !String(name).trim() || !(row.price >= 0) || isNaN(row.price)) return r.status(400).json({ error: 'Preencha o nome e o preço do plano' });
  const x = id ? await sb.from('plans').update(row).eq('id', id) : await sb.from('plans').insert(row);
  if (x.error) { console.error('plan:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true });
});
app.delete('/api/admin/plan/:id', adm, async (q, r) => {
  const a = await sb.from('keys').delete().eq('plan_id', q.params.id).eq('used', false);
  if (a.error) return r.status(500).json({ error: 'Banco: ' + a.error.message });
  const b = await sb.from('plans').delete().eq('id', q.params.id);
  if (b.error) return r.status(500).json({ error: 'Banco: ' + b.error.message });
  r.json({ ok: true });
});
app.post('/api/admin/keys', adm, async (q, r) => {
  const ks = [...new Set(String(q.body.keys).split('\n').map(x => x.trim()).filter(Boolean))].map(key => ({ plan_id: q.body.plan_id, key }));
  if (!ks.length) return r.json({ ok: false, error: 'Nenhuma key' });
  const x = await sb.from('keys').insert(ks);
  if (x.error) { console.error('keys:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true, added: ks.length });
});

const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
app.post('/api/admin/upload', adm, express.raw({ type: () => true, limit: '25mb' }), async (q, r) => {
  const kind = q.query.kind, ct = String(q.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), ext = MIME[ct];
  if (!['image', 'logo'].includes(kind)) return r.status(400).json({ error: 'Tipo inválido' });
  if (!ext) return r.status(400).json({ error: 'Formato não aceito. Use PNG, JPG, WEBP, GIF, MP4 ou WEBM' });
  if (!Buffer.isBuffer(q.body) || !q.body.length) return r.status(400).json({ error: 'Arquivo vazio' });
  const p = kind + '-' + Date.now() + '.' + ext, put = () => sb.storage.from('media').upload(p, q.body, { contentType: ct, upsert: true });
  let x = await put();
  if (x.error && /bucket/i.test(x.error.message)) { await sb.storage.createBucket('media', { public: true }); x = await put(); }
  if (x.error) { console.error('upload:', x.error); return r.status(500).json({ error: 'Storage: ' + x.error.message }); }
  const url = sb.storage.from('media').getPublicUrl(p).data.publicUrl;
  const s = await sb.from('settings').upsert({ k: kind, v: url }, { onConflict: 'k' });
  if (s.error) { console.error('upload set:', s.error); return r.status(500).json({ error: 'Banco: ' + s.error.message }); }
  r.json({ ok: true, url });
});
app.delete('/api/admin/media/:kind', adm, async (q, r) => {
  if (!['image', 'logo'].includes(q.params.kind)) return r.status(400).json({ error: 'Tipo inválido' });
  const s = await sb.from('settings').upsert({ k: q.params.kind, v: '' }, { onConflict: 'k' });
  if (s.error) return r.status(500).json({ error: 'Banco: ' + s.error.message });
  r.json({ ok: true });
});

app.listen(E.PORT || 3000, () => console.log('CYBER ONLINE no ar'));
