// /api/send-order-email.js
// Triggered by a Supabase Database Webhook whenever a row in `orders` is updated.
// Only sends an email if the status actually changed.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const STATUS_CONTENT = {
  processing: {
    subject: 'Order received — M.U.D Misunderstood',
    heading: 'we got your order',
    body: 'thanks for the order. we\'re getting it ready — you\'ll get another email the moment it ships.'
  },
  shipped: {
    subject: 'Your order has shipped — M.U.D Misunderstood',
    heading: 'it\'s on the way',
    body: 'your order has left the building. check your account page for delivery updates.'
  },
  delivered: {
    subject: 'Order delivered — M.U.D Misunderstood',
    heading: 'delivered',
    body: 'your order has been marked as delivered. hope you love it — tag us when you wear it.'
  },
  cancelled: {
    subject: 'Order cancelled — M.U.D Misunderstood',
    heading: 'order cancelled',
    body: 'this order has been cancelled. if you weren\'t expecting this, get in touch and we\'ll sort it out.'
  }
};

function buildEmailHtml(name, orderId, statusInfo) {
  return `<div style="background-color:#060606;padding:40px 20px;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#0d0d0d;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;">
    <tr><td style="padding:36px 32px 0;text-align:center;">
      <span style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;text-transform:uppercase;">M.U.D <span style="color:#e63329;">MISUNDERSTOOD</span></span>
    </td></tr>
    <tr><td style="padding:32px 32px 0;text-align:center;">
      <span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#e63329;">order ${orderId}</span>
    </td></tr>
    <tr><td style="padding:14px 32px 0;text-align:center;">
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-.02em;color:#fff;text-transform:uppercase;margin:0;">${statusInfo.heading}${name ? ', ' + name : ''}</h1>
    </td></tr>
    <tr><td style="padding:16px 32px 0;text-align:center;">
      <p style="font-size:14px;line-height:1.6;color:rgba(255,255,255,.55);margin:0;">${statusInfo.body}</p>
    </td></tr>
    <tr><td style="padding:32px 32px 0;text-align:center;">
      <a href="https://www.mudstreetwear.co.za" style="display:inline-block;background-color:#e63329;color:#fff;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;padding:14px 32px;border-radius:999px;">view your account</a>
    </td></tr>
    <tr><td style="padding:32px 32px 32px;text-align:center;">
      <div style="height:1px;background-color:rgba(255,255,255,.08);margin:0 0 20px;"></div>
      <span style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.2);">m.u.d misunderstood &middot; centurion, south africa</span>
    </td></tr>
  </table>
</div>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const newRecord = payload.record;
    const oldRecord = payload.old_record;

    // Only act on genuine status changes
    if (!newRecord || !oldRecord || newRecord.status === oldRecord.status) {
      return res.status(200).json({ skipped: true });
    }

    const statusInfo = STATUS_CONTENT[newRecord.status];
    if (!statusInfo) return res.status(200).json({ skipped: true, reason: 'unrecognized status' });

    // Look up the customer's email + name via Supabase admin API
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newRecord.user_id}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const user = await userRes.json();
    if (!user || !user.email) return res.status(200).json({ skipped: true, reason: 'no user email' });

    const name = user.user_metadata?.full_name || '';

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'M.U.D Misunderstood <noreply@mudstreetwear.co.za>',
        to: user.email,
        subject: statusInfo.subject,
        html: buildEmailHtml(name, newRecord.id, statusInfo)
      })
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend send failed:', errText);
      return res.status(500).json({ error: 'email send failed' });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('send-order-email error', err);
    return res.status(500).end();
  }
};
