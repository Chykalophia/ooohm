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
