// supabase/functions/stripe-webhook/index.ts
//
// Supabase Edge Function — receives Stripe webhook events
// and writes completed purchases to the `purchases` table.
//
// Deploy with:
//   supabase functions deploy stripe-webhook
//
// Set secrets with:
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//   supabase secrets set STRIPE_SECRET_KEY=sk_live_...

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.18.0?target=deno'

// ── Env vars (set via `supabase secrets set`)
const STRIPE_SECRET_KEY      = Deno.env.get('STRIPE_SECRET_KEY')      ?? ''
const STRIPE_WEBHOOK_SECRET  = Deno.env.get('STRIPE_WEBHOOK_SECRET')  ?? ''
const SUPABASE_URL           = Deno.env.get('SUPABASE_URL')           ?? ''
const SUPABASE_SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// ── Stripe price IDs → course mapping
// Replace these with your actual Stripe Price IDs after creating Payment Links
const PRICE_TO_COURSE: Record<string, string> = {
  'price_MANUAL_PRICE_ID':    'manual',     // ← replace after Step 3 of guide
  'price_AUTOMATIC_PRICE_ID': 'automatic',  // ← replace after Step 3 of guide
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

serve(async (req: Request) => {
  // ── Only accept POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const body      = await req.text()
  const signature = req.headers.get('stripe-signature') ?? ''

  // ── Verify webhook signature (prevents spoofed requests)
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  // ── Only handle successful checkouts
  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ received: true }), { status: 200 })
  }

  const session = event.data.object as Stripe.Checkout.Session

  // ── Extract the Supabase user ID from client_reference_id
  const userId = session.client_reference_id
  if (!userId) {
    console.error('No client_reference_id on session:', session.id)
    return new Response('Missing user ID', { status: 400 })
  }

  // ── Determine which course was purchased
  // Get line items to find the price ID
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 5,
  })

  const priceId = lineItems.data[0]?.price?.id ?? ''
  const course  = PRICE_TO_COURSE[priceId]

  if (!course) {
    console.error(`Unknown price ID: ${priceId}`)
    return new Response(`Unknown course for price: ${priceId}`, { status: 400 })
  }

  // ── Write to Supabase purchases table
  // Use service role key so RLS doesn't block the insert
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const expiresAt = new Date()
  expiresAt.setFullYear(expiresAt.getFullYear() + 1) // 12 months access

  const { error } = await sb.from('purchases').upsert({
    user_id:           userId,
    course:            course,
    stripe_session_id: session.id,
    purchased_at:      new Date().toISOString(),
    expires_at:        expiresAt.toISOString(),
  }, {
    onConflict: 'user_id,course', // prevent duplicates if webhook fires twice
    ignoreDuplicates: false,
  })

  if (error) {
    console.error('Supabase insert error:', error)
    return new Response(`Database error: ${error.message}`, { status: 500 })
  }

  console.log(`✅ Purchase recorded: user=${userId} course=${course} session=${session.id}`)

  return new Response(JSON.stringify({ success: true, course, userId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
