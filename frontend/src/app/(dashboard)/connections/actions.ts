"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { encryptMT5Password } from "@/utils/crypto";

export async function addConnection(formData: FormData) {
  const supabase = await createClient();
  
  // Get the current user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Unauthorized");
  }

  const broker_server = formData.get("broker_server") as string;
  const account_login = formData.get("account_login") as string;
  const plaintextPassword = formData.get("password") as string;

  const masterKey = process.env.MT5_CREDENTIALS_MASTER_KEY_B64;
  if (!masterKey) {
    throw new Error("Server configuration error: Encryption key missing");
  }

  // Encrypt password securely on the server
  const { ciphertextB64, nonceB64 } = encryptMT5Password(plaintextPassword, masterKey);

  // Insert into database
  const { error } = await supabase.from("mt5_user_connections").insert({
    user_id: user.id,
    broker_server,
    account_login,
    password_ciphertext_b64: ciphertextB64,
    password_nonce_b64: nonceB64,
    is_active: true,
    status: "offline",
  });

  if (error) {
    console.error("Failed to insert connection:", error);
    throw new Error("Failed to add connection. Check logs.");
  }

  revalidatePath("/connections");
}

export async function deleteConnection(formData: FormData) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Unauthorized");
  }

  const id = formData.get("id") as string;
  if (!id) throw new Error("Connection ID required");

  // Securely delete only if the user owns it
  const { error } = await supabase
    .from("mt5_user_connections")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    console.error("Failed to delete connection:", error);
    throw new Error("Failed to delete connection. Check logs.");
  }

  revalidatePath("/connections");
}
