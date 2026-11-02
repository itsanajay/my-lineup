// Settings for optional sign-in and sync (Supabase). Leave both empty to run
// the app with no accounts: everything is saved on the phone only.
// These two values are public by design; the database rules in
// supabase/schema.sql make sure each person can only see their own data.
window.LL_CONFIG = {
  supabaseUrl: 'https://axvnbcpqluwsuaqxbpfy.supabase.co',
  supabaseKey: 'sb_publishable_v9Si9nSBWdMQnozTc_rhhQ_pu_7vJVb',
};
