// /api/payfast-itn.js
// Payfast calls this directly, server-to-server, once payment completes.
// This is the ONLY place an order is ever considered genuinely paid.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function buildInvoiceHtml(name, order, lineItems) {
  const rows = lineItems.map(li => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#fff;font-size:13px;">${li.name}<br/><span style="color:rgba(255,255,255,.4);font-size:11px">size ${li.size} &times; ${li.qty}</span></td>
      <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#fff;font-size:13px;text-align:right;">R ${li.lineTotal.toLocaleString()}</td>
    </tr>`).join('');

  const deliveryLabel = order.delivery_option === 'express' ? 'Express delivery (4–7 working days)' : 'Standard delivery (7–10 working days)';
  const deliveryLine = order.delivery_fee === 0
    ? `<span style="color:#4ade80">FREE</span>`
    : `R ${order.delivery_fee.toLocaleString()}`;

  return `<div style="background-color:#060606;padding:40px 20px;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#0d0d0d;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;">
    <tr><td style="padding:36px 32px 0;text-align:center;">
      <span style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;text-transform:uppercase;">M.U.D <span style="color:#e63329;">MISUNDERSTOOD</span></span>
    </td></tr>
    <tr><td style="padding:32px 32px 0;text-align:center;">
      <span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#e63329;">order confirmed</span>
    </td></tr>
    <tr><td style="padding:14px 32px 0;text-align:center;">
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-.02em;color:#fff;text-transform:uppercase;margin:0;">thanks${name ? ', ' + name : ''}</h1>
      <p style="font-size:12px;color:rgba(255,255,255,.4);margin:8px 0 0;">order ${order.id}</p>
    </td></tr>
    <tr><td style="padding:28px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows}
        <tr><td style="padding:14px 0 4px;color:rgba(255,255,255,.5);font-size:12px;">${deliveryLabel}</td><td style="padding:14px 0 4px;color:#fff;font-size:13px;text-align:right;">${deliveryLine}</td></tr>
        <tr><td style="padding:14px 0 0;color:#fff;font-size:15px;font-weight:700;border-top:1px solid rgba(255,255,255,.1);">total</td><td style="padding:14px 0 0;color:#fff;font-size:15px;font-weight:700;text-align:right;border-top:1px solid rgba(255,255,255,.1);">R ${order.total.toLocaleString()}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:32px 32px 0;text-align:center;">
      <a href="https://www.mudstreetwear.co.za" style="display:inline-block;background-color:#e63329;color:#fff;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;padding:14px 32px;border-radius:999px;">track your order</a>
    </td></tr>
    <tr><td style="padding:32px 32px 32px;text-align:center;">
      <div style="height:1px;background-color:rgba(255,255,255,.08);margin:0 0 20px;"></div>
      <span style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.2);">m.u.d misunderstood &middot; centurion, south africa</span>
    </td></tr>
  </table>
</div>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  try {
    const data = req.body;

    const rawBody = new URLSearchParams(data).toString();
    const validateRes = await fetch('https://www.payfast.co.za/eng/query/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody
    });
    const validateText = (await validateRes.text()).trim();
    if (validateText !== 'VALID') {
      console.error('Payfast ITN failed validation:', validateText);
      return res.status(400).end();
    }

    if (data.payment_status !== 'COMPLETE') {
      return res.status(200).end();
    }

    const pendingId = data.m_payment_id;
    const pendingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pending_orders?id=eq.${pendingId}&select=*`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const pendingRows = await pendingRes.json();
    const pending = pendingRows[0];
    if (!pending) {
      console.error('No pending order found for', pendingId);
      return res.status(200).end();
    }

    const paidAmount = parseFloat(data.amount_gross || data.amount);
    if (Math.abs(paidAmount - pending.amount) > 0.5) {
      console.error(`Amount mismatch on ${pendingId}: staged ${pending.amount}, paid ${paidAmount}`);
      return res.status(200).end();
    }

    // Finalize the real order — fires the DB trigger that re-validates price/stock
    // AND computes the authoritative delivery fee + total server-side
    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        id: pendingId,
        user_id: pending.user_id,
        items: pending.items,
        total: pending.amount,
        status: 'processing',
        delivery_option: pending.delivery_option || 'standard'
      })
    });

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error(`CRITICAL: payment succeeded but order finalization failed for ${pendingId}:`, errText);
      await fetch(`${SUPABASE_URL}/rest/v1/pending_orders?id=eq.${pendingId}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      return res.status(200).end();
    }

    const [savedOrder] = await orderRes.json();

    await fetch(`${SUPABASE_URL}/rest/v1/pending_orders?id=eq.${pendingId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

    // Send the invoice — look up product names/prices for itemized lines
    try {
      const ids = [...new Set(pending.items.map(i => i.id))];
      const filter = ids.map(id => `"${id}"`).join(',');
      const prodRes = await fetch(
        `${SUPABASE_URL}/rest/v1/products?id=in.(${filter})&select=id,name,price`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const products = await prodRes.json();
      const byId = Object.fromEntries(products.map(p => [p.id, p]));
      const lineItems = pending.items.map(i => ({
        name: byId[i.id]?.name || i.id,
        size: i.size,
        qty: i.qty,
        lineTotal: (byId[i.id]?.price || 0) * i.qty
      }));

      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${pending.user_id}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const user = await userRes.json();
      const name = user?.user_metadata?.full_name || '';

      if (user?.email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'M.U.D Misunderstood <noreply@mudstreetwear.co.za>',
            to: user.email,
            subject: `Order confirmed — ${savedOrder.id}`,
            html: buildInvoiceHtml(name, savedOrder, lineItems)
          })
        });
      }

      // Notify the merchant too — a sale happening with nobody knowing isn't much use
      const itemsSummary = lineItems.map(li => `${li.qty}x ${li.name} (${li.size}) — R${li.lineTotal}`).join('<br/>');
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'M.U.D Misunderstood <noreply@mudstreetwear.co.za>',
          to: 'admin@mudstreetwear.co.za',
          subject: `🎉 New order — ${savedOrder.id} — R${savedOrder.total}`,
          html: `<div style="font-family:Helvetica,Arial,sans-serif;padding:20px;color:#111">
            <h2>New order: ${savedOrder.id}</h2>
            <p><strong>Customer:</strong> ${name || 'N/A'} (${user?.email || 'no email'})</p>
            <p><strong>Items:</strong><br/>${itemsSummary}</p>
            <p><strong>Delivery:</strong> ${savedOrder.delivery_option} (R${savedOrder.delivery_fee})</p>
            <p><strong>Total paid:</strong> R${savedOrder.total}</p>
            <p>Update the order status in Supabase Table Editor when you ship it.</p>
          </div>`
        })
      });
    } catch (invoiceErr) {
      console.error('Invoice/notification email failed to send', invoiceErr);
    }

    return res.status(200).end();
  } catch (err) {
    console.error('payfast-itn error', err);
    return res.status(500).end();
  }
};
