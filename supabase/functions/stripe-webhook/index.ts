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
//   supabase secrets set SUPABASE_URL=https://your-project.supabase.co
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import Stripe from 'https://esm.sh/stripe@17.4.0?target=deno'

// ============================================================================
// CONFIGURATION MODULE
// ============================================================================

interface Config {
  stripeSecretKey: string
  stripeWebhookSecret: string
  supabaseUrl: string
  supabaseServiceKey: string
  stripeApiVersion: string
  defaultAccessMonths: number
}

interface CourseMapping {
  [priceId: string]: string
}

const COURSE_MAPPING: CourseMapping = {
  'price_MANUAL_PRICE_ID': 'manual',     // ← Replace with actual Stripe Price ID
  'price_AUTOMATIC_PRICE_ID': 'automatic', // ← Replace with actual Stripe Price ID
}

/**
 * Validates and retrieves configuration from environment variables
 */
function getConfig(): Config {
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const errors: string[] = []

  if (!stripeSecretKey) errors.push('STRIPE_SECRET_KEY')
  if (!stripeWebhookSecret) errors.push('STRIPE_WEBHOOK_SECRET')
  if (!supabaseUrl) errors.push('SUPABASE_URL')
  if (!supabaseServiceKey) errors.push('SUPABASE_SERVICE_ROLE_KEY')

  if (errors.length > 0) {
    throw new Error(`Missing required environment variables: ${errors.join(', ')}`)
  }

  return {
    stripeSecretKey,
    stripeWebhookSecret,
    supabaseUrl,
    supabaseServiceKey,
    stripeApiVersion: '2024-12-18.acacia',
    defaultAccessMonths: 12,
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface WebhookResponse {
  success?: boolean
  course?: string
  userId?: string
  sessionId?: string
  received?: boolean
  error?: string
}

interface PurchaseRecord {
  user_id: string
  course: string
  stripe_session_id: string
  purchased_at: string
  expires_at: string
}

// ============================================================================
// STRIPE CLIENT INITIALIZATION
// ============================================================================

function initializeStripe(apiKey: string, apiVersion: string): Stripe {
  return new Stripe(apiKey, {
    apiVersion,
    httpClient: Stripe.createFetchHttpClient(),
  })
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validates that a string is a valid UUID format
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(uuid)
}

/**
 * Validates session object has required fields
 */
function validateSession(session: Stripe.Checkout.Session): { valid: boolean; error?: string } {
  if (!session.id) {
    return { valid: false, error: 'Session ID is missing' }
  }

  if (!session.client_reference_id) {
    return { valid: false, error: 'client_reference_id is missing' }
  }

  if (!isValidUUID(session.client_reference_id)) {
    console.warn(`client_reference_id '${session.client_reference_id}' is not a valid UUID format`)
    // We'll still proceed but log a warning
  }

  return { valid: true }
}

/**
 * Validates price ID exists in our course mapping
 */
function validatePriceId(priceId: string): { valid: boolean; course?: string; error?: string } {
  if (!priceId) {
    return { valid: false, error: 'Price ID is empty' }
  }

  const course = COURSE_MAPPING[priceId]
  if (!course) {
    return { valid: false, error: `Unknown price ID: ${priceId}` }
  }

  return { valid: true, course }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handles checkout.session.completed events
 */
async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
  supabase: SupabaseClient,
  config: Config
): Promise<{ status: number; body: WebhookResponse }> {
  // Validate session
  const validation = validateSession(session)
  if (!validation.valid) {
    console.error('Session validation failed:', validation.error)
    return {
      status: 400,
      body: { error: validation.error ?? 'Invalid session' },
    }
  }

  const userId = session.client_reference_id!

  try {
    // Fetch line items to determine which course was purchased
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 5,
    })

    if (!lineItems.data || lineItems.data.length === 0) {
      console.error('No line items found in session:', session.id)
      return {
        status: 400,
        body: { error: 'No line items found in checkout session' },
      }
    }

    const priceId = lineItems.data[0]?.price?.id ?? ''
    const priceValidation = validatePriceId(priceId)

    if (!priceValidation.valid) {
      console.error('Price validation failed:', priceValidation.error)
      return {
        status: 400,
        body: { error: priceValidation.error ?? 'Invalid price' },
      }
    }

    const course = priceValidation.course!

    // Calculate expiration date
    const expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + config.defaultAccessMonths)

    // Create purchase record
    const purchaseRecord: PurchaseRecord = {
      user_id: userId,
      course: course,
      stripe_session_id: session.id,
      purchased_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    }

    // Insert or update purchase record in Supabase
    const { error: dbError } = await supabase
      .from('purchases')
      .upsert(purchaseRecord, {
        onConflict: 'user_id,course',
        ignoreDuplicates: false,
      })

    if (dbError) {
      console.error('Supabase upsert error:', dbError)
      return {
        status: 500,
        body: { error: `Database error: ${dbError.message}` },
      }
    }

    console.log(
      `✅ Purchase recorded successfully:`,
      `user=${userId}`,
      `course=${course}`,
      `session=${session.id}`
    )

    return {
      status: 200,
      body: { success: true, course, userId, sessionId: session.id },
    }
  } catch (error) {
    console.error('Error processing checkout session:', error)
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Unknown error occurred' },
    }
  }
}

/**
 * Handles other Stripe events (for future extensibility)
 */
async function handleOtherEvent(eventType: string): Promise<{ status: number; body: WebhookResponse }> {
  console.log(`ℹ️ Received event type '${eventType}' - no action required`)
  return {
    status: 200,
    body: { received: true },
  }
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================

async function handleWebhook(req: Request, config: Config): Promise<Response> {
  const stripe = initializeStripe(config.stripeSecretKey, config.stripeApiVersion)
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

  // Validate HTTP method
  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Allow': 'POST' },
    })
  }

  // Read request body
  let body: string
  try {
    body = await req.text()
  } catch (error) {
    console.error('Error reading request body:', error)
    return new Response('Failed to read request body', { status: 400 })
  }

  // Get signature from headers
  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    console.error('Missing stripe-signature header')
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  // Verify webhook signature
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      config.stripeWebhookSecret
    )
  } catch (error) {
    console.error('Webhook signature verification failed:', error)
    return new Response(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
      status: 400,
    })
  }

  // Route event to appropriate handler
  let response: { status: number; body: WebhookResponse }

  switch (event.type) {
    case 'checkout.session.completed':
      response = await handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
        stripe,
        supabase,
        config
      )
      break

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      response = await handleOtherEvent(event.type)
      break

    default:
      console.log(`⚠️ Unhandled event type: ${event.type}`)
      response = { status: 200, body: { received: true } }
  }

  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': event.id,
    },
  })
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

function handleHealthCheck(): Response {
  return new Response(
    JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
}

// ============================================================================
// SERVER ENTRY POINT
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  // Health check endpoint (GET /health)
  if (req.method === 'GET' && req.url.endsWith('/health')) {
    return handleHealthCheck()
  }

  // Load and validate configuration
  let config: Config
  try {
    config = getConfig()
  } catch (error) {
    console.error('Configuration error:', error)
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  // Process webhook
  return await handleWebhook(req, config)
})
