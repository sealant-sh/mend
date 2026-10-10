---
"@sealant/mend": patch
---

The dashboard's snake no longer starts behind your back. It waits on the board until it has the
keyboard, then counts down 3, 2, 1, go in big half-block digits sized to the board (small ones on a
short terminal), with the snake visible underneath, and moves only after go. Starting or resuming a
session from the dashboard gives the game the keyboard once the session's pane shows it, and so do
Enter, `l` or `→` into a starting session's pane. While the game has the keyboard its board border
is the accent colour, and the arrows and `h j k l` steer it. Space or `p` pauses, and the countdown
runs again before the game resumes. Esc or `q` hands the keyboard back to the list you were in. No
other key acts on the dashboard behind the game. The keys are listed under the board and in the
footer. A dialog that opens over the game, such as the adopt offer at the start of `mend snake`,
keeps the keyboard until it closes, and then the countdown starts.
