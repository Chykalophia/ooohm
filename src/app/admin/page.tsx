import { redirect } from "next/navigation";
import { requireAdminPage } from "@/app/admin/admin-shell";

/** `/admin` opens on People. */
export default async function AdminIndexPage() {
  await requireAdminPage();
  redirect("/admin/people");
}
