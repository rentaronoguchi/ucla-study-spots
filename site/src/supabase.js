import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || "https://yspcuwftnpmmedhsqqtf.supabase.co",
  import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_OCiTAjLgcTbQagq6xtLMSA_KMkNkp6D"
);