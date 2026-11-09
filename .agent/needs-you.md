# Needs You: pick the date picker design

resume_at: cklph Build v3 / Spec Revise

Three mockups of the themed date picker are in `.agent/design/` (open `option-a.html`, `option-b.html` and `option-c.html` from the task's file viewer or the `feature/review-date-picker-t-352` branch). Each one is interactive and has a theme, mode, corner and accent switcher. `.agent/design/README.md` gives one paragraph per option.

## Questions

1. **Which option?**
   - A: Quiet popover. It matches the sentence's existing menus, with a button-shaped selected day and a dot for today. ★ recommended
   - B: Framed form panel. Full-size typed field, ring for today, square cells and a full-width "Today" button.
   - C: Sentence-scale calendar. Big display-face month, underline for today, an underline-only typed field and "Today · Mon, Nov 9".
2. **Today marker:** keep the chosen option's marker, or swap in another one (dot, ring or underline)?
3. **On phones:** keep the chosen option's placement, or always pin the popup to the screen's side margins (1rem)?

## For the Needs You agent

Save the answers to `.agent/design/CHOSEN.md` in this form: the chosen option and its file, any swaps from questions 2 and 3, and Peter's exact words. Then route to `cklph Build v3 / Spec Revise`. Spec Revise should also fix AC1(a): November 2026 has 12 out-of-month dates, not 7 (see README.md).
