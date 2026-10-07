# CreatorAI (MVP)
Node 20.11+ / Express / SQLite. Vanilla-JS responsive front end in `public/`. Not yet executed end to end: install, then test each flow with your own keys.

## Run
    npm install && cp .env.example .env   # fill in JWT_SECRET at minimum
    npm start                             # http://localhost:3000

## Accounts and keys
- Replicate (REPLICATE_API_TOKEN): image and video. Anthropic (ANTHROPIC_API_KEY): captions.
- Google Cloud OAuth Web client ID (GOOGLE_CLIENT_ID); add your domain as an authorised JavaScript origin.
- Paystack secret key (Nigeria, NGN); Stripe secret key + webhook secret (international, USD).

## AI
`providers.js` is the only file that talks to AI vendors. Models are set in `.env`. Input field names (`input_image`, `image`, `duration`) must match the model you choose; check its Replicate page. Jobs are async: `/api/generate` charges credits and starts a job, the app polls `/api/generations/:id`, the server saves the file, and failures refund automatically.

## Payments
- Paystack: dashboard > Settings > API & Webhooks, webhook URL `https://YOURDOMAIN/webhooks/paystack`.
- Stripe: webhook URL `https://YOURDOMAIN/webhooks/stripe`, events `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.
- Credits are granted only after a verified webhook or a server-side Paystack verify call, once per payment. Never on a redirect alone.
- Test with Paystack/Stripe test keys first. Edit prices in `server.js` (PACKS, PLANS).

## Publish
Deploy to a Node host with a persistent disk (Railway, Render, Fly.io) behind HTTPS; set `NODE_ENV=production` and `APP_URL`. Before real users: move to Postgres (schema is portable), store media in S3/R2, add a background worker to finish jobs when users leave, add email verification and password reset, and publish privacy policy/terms. For app stores, wrap with Capacitor or rebuild in React Native.

## Revenue (no guarantees)
Users buy credit packs or monthly plans. Margin = price minus AI cost per generation minus payment fees. Check real per-generation costs with your provider, then set credit prices with headroom. Free credits are an acquisition cost, so watch abuse (one signup bonus per email; consider phone or device checks).
