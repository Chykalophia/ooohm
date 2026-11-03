import { redirect } from "next/navigation";
import { requireAdminPage } from "@/app/_lib/page-context";

/** `/admin` opens on People. */
export default async function AdminIndexPage() {
  await requireAdminPage();
  redirect("/admin/people");
}
