/**
 * Result of a form's server action, as rendered by `useActionState`. `id` changes on
 * every success so a form can remount (clear) itself by using it as a React key.
 */
export type FormState =
  | { status: "idle" }
  | { status: "success"; message: string; id: string }
  | { status: "error"; message: string };

export const IDLE: FormState = { status: "idle" };

/**
 * The React key for a form's fields after `state` arrives. It changes only on a new
 * success, so the fields clear after a submit goes through but keep what the person
 * typed when a later submit fails.
 *
 * @param current The key in use before `state` arrived.
 */
export function nextFormKey(current: string, state: FormState): string {
  return state.status === "success" ? state.id : current;
}

/**
 * Whether the request form shows its live preview. Right after a successful submit the
 * fields are back at their defaults, so a preview would describe a request nobody made
 * and read as if it described the one just sent. It stays hidden until the draft differs
 * from those defaults.
 *
 * @param justSubmitted The fields were remounted by a successful submit.
 */
export function showsPreview(
  justSubmitted: boolean,
  draft: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): boolean {
  if (!justSubmitted) return true;
  return Object.keys(defaults).some((name) => draft[name] !== defaults[name]);
}
