# Local Listings

A retro TV guide for the streaming age. Add the shows you follow and they fill in a classic channel grid on the days new episodes come out. Shows that are between seasons wait on a "Returning soon" shelf and move back into the guide when their next season is dated.

## How it works

- Plain HTML, CSS and JavaScript. No build step, no server, no accounts.
- Show and episode schedules come from the free [TVmaze API](https://www.tvmaze.com/api). No key needed.
- Your list of shows is saved in your phone's browser, so it stays private to you.

## Put it on your phone

Open the site on your phone, then:

- **iPhone (Safari):** tap the Share button, then **Add to Home Screen**.
- **Android (Chrome):** tap the ⋮ menu, then **Add to Home screen** or **Install app**.

It opens full screen like a regular app and still works offline with your last loaded guide.

## Try it

Open `index.html` in a browser, or turn on GitHub Pages (Settings → Pages → Deploy from branch → `main`, folder `/`) and open the link it gives you.

Show data provided by [TVmaze](https://www.tvmaze.com), licensed under CC BY-SA.

## Optional sign-in and sync

Sign-in uses a free [Supabase](https://supabase.com) project. To turn it on:

1. In Supabase, open **SQL Editor**, paste in `supabase/schema.sql` and tap **Run**.
2. Under **Authentication → Sign In / Providers → Email**, turn off **Confirm email** (the free email sender only reaches your own team).
3. Put the Project URL and publishable key in `config.js`.

With `config.js` left empty, the app works with no accounts and keeps everything on the phone.
