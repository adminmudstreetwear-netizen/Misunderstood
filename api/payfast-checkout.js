// /api/payfast-checkout.js
// Runs server-side on Vercel. Never trusts client-submitted prices.
// Looks up real prices from Supabase, stages a pending order, and returns
// a signed Payfast payment request for the browser to submit.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || ''; // not set for this account

const SITE_URL = 'https://www.mudstreetwear.co.za';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, deliveryOption } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }
    const delivery = deliveryOption === 'express' ? 'express' : 'standard';

    // 1. Identify the real user from their auth token — never trust a client-passed user_id
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not signed in' });

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    const user = await userRes.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

    // 2. Look up REAL prices from the database — ignore any price the client sent
    const ids = [...new Set(items.map(i => i.id))];
    const filter = ids.map(id => `"${id}"`).join(',');
    const prodRes = await fetch(
      `${SUPABASE_URL}/rest/v1/products?id=in.(${filter})&select=id,name,price,sold_out_sizes,stock_by_size,in_stock`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const products = await prodRes.json();
    const byId = Object.fromEntries(products.map(p => [p.id, p]));

    let total = 0;
    for (const item of items) {
      const prod = byId[item.id];
      if (!prod) return res.status(400).json({ error: `Product ${item.id} not found` });
      if (prod.in_stock === false) return res.status(400).json({ error: `${prod.name} is no longer available` });
      const stock = (prod.stock_by_size && prod.stock_by_size[item.size]) || 0;
      const soldOut = (prod.sold_out_sizes || []).includes(item.size);
      if (soldOut || stock < item.qty) {
        return res.status(400).json({ error: `${prod.name} (size ${item.size}) is out of stock` });
      }
      total += prod.price * item.qty;
    }

    // Delivery fee — must exactly match the database trigger's logic,
    // since the trigger is the final authority on the actual charge
    const deliveryFee = delivery === 'express' ? 120 : (total >= 500 ? 0 : 85);
    const grandTotal = total + deliveryFee;

    // 3. Stage the order — real orders table only gets written once payment is confirmed
    const pendingId = 'PO-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await fetch(`${SUPABASE_URL}/rest/v1/pending_orders`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ id: pendingId, user_id: user.id, items, amount: grandTotal, delivery_option: delivery })
    });

    // 4. Build the signed Payfast payment request
    const fields = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_URL}/?payment=success`,
      cancel_url: `${SITE_URL}/?payment=cancelled`,
      notify_url: `${SITE_URL}/api/payfast-itn`,
      name_first: user.user_metadata?.full_name || 'Customer',
      email_address: user.email || '',
      m_payment_id: pendingId,
      amount: grandTotal.toFixed(2),
      item_name: 'M.U.D Misunderstood Order',
    };

    const paramString = Object.entries(fields)
      .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
      .join('&');
    const signString = PAYFAST_PASSPHRASE
      ? `${paramString}&passphrase=${encodeURIComponent(PAYFAST_PASSPHRASE).replace(/%20/g, '+')}`
      : paramString;
    const signature = crypto.createHash('md5').update(signString).digest('hex');

    return res.status(200).json({
      action: 'https://www.payfast.co.za/eng/process',
      fields: { ...fields, signature }
    });
  } catch (err) {
    console.error('payfast-checkout error', err);
    return res.status(500).json({ error: 'Checkout failed — please try again' });
  }
};
