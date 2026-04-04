import { createClient } from "@supabase/supabase-js";

// Lazy initialisation — only crash if Supabase is actually used without env vars
function makeClient() {
  const url = Bun.env.SUPABASE_URL;
  const key = Bun.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    // Return a stub that throws a clear error on use (demo mode never calls this)
    return createClient("https://placeholder.supabase.co", "placeholder-key");
  }
  return createClient(url, key);
}

export const supabase = makeClient();
