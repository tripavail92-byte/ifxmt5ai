"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

export async function login(formData: FormData) {
  const supabase = await createClient();
  const next = ((formData.get("next") as string | null) ?? "/").trim() || "/";

  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const { error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    return redirect("/login?message=" + encodeURIComponent(error.message) + "&next=" + encodeURIComponent(next));
  }

  revalidatePath("/", "layout");
  redirect(next);
}
