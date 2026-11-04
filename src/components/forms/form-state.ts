/**
 * Result of a form's server action, as rendered by `useActionState`. `id` changes on
 * every success so a form can remount (clear) itself by using it as a React key.
 */
export type FormState =
  | { status: "idle" }
  | { status: "success"; message: string; id: string }
  | { status: "error"; message: string; /** Names of the fields to mark invalid. */ fields?: string[] };

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
