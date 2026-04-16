# D4Driving Online Course Platform

**Live site:** [learn.d4driving.co.uk](https://learn.d4driving.co.uk)  
**Main site:** [d4driving.co.uk](https://www.d4driving.co.uk)  
**Hosted on:** GitHub Pages

---

## What This Is

The D4Driving Online Course Platform — a standalone site selling video-based driving courses for learner drivers. Built and maintained by Robert at D4Driving School of Motoring, Peterborough.

- Manual course (Toyota Aygo X) — 66 videos
- Automatic course (Toyota Yaris Cross) — 62 videos
- 15 modules covering every driving topic
- Exclusive local test route guides: Peterborough, Grantham & Kettering
- Free theory bundle included with every course

---

## File Structure

```
d4driving-learn/
├── index.html              ← Marketing landing page
├── login.html              ← Sign in / register / reset password
├── dashboard.html          ← Post-login course dashboard
├── course-manual.html      ← Manual course video player (in progress)
├── course-automatic.html   ← Automatic course video player (in progress)
├── CNAME                   ← learn.d4driving.co.uk
└── README.md               ← This file
```

---

## Tech Stack

| Layer | Tool |
|---|---|
| Hosting | GitHub Pages (free) |
| Auth + Database | Supabase (free tier) |
| Video hosting | Unlisted YouTube → Vimeo later |
| Payments | Stripe |
| Font | Plus Jakarta Sans |

---

## Setup Required Before Going Live

1. Add Supabase URL + anon key to `login.html` and `dashboard.html`
2. Replace Stripe Payment Link placeholders in `dashboard.html`
3. Add Wix DNS CNAME record: `learn` → `d4driving.github.io`

Full setup instructions: see `SUPABASE-SETUP.md`

---

## Brand

- Red `#BD2026` · Slate `#2C3E50` · Sage `#8fa3a0` · Background `#fbfdff`
- Font: Plus Jakarta Sans
- Matches [d4driving.co.uk](https://www.d4driving.co.uk)

---

© 2026 D4Driving School of Motoring. All rights reserved.
