"""Print a TLC counterexample from StandbyDiscard as one line per step.

Reads TLC's output (with or without -difftrace) on stdin and prints each step's action and
what it changed, by key, so a trace reads as "CTake: status[s1] ready -> claimed".

    docs/specs/formal/standby-discard/check.sh code-promise | python3 -I docs/specs/formal/standby-discard/trace.py
"""

import re
import sys

STEP = re.compile(r"^State (\d+): <(\w+)")
ASSIGN = re.compile(r"^/\\ (\w+) = (.*)$")


def entries(value):
    """A TLC function value `(k1 :> v1 @@ k2 :> v2)` as a dict; anything else as itself."""
    text = value.strip()
    if ":>" not in text:
        return text
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    found = {}
    for part in text.split("@@"):
        key, _, val = part.partition(":>")
        found[re.sub(r"\s+", " ", key.strip())] = re.sub(r"\s+", " ", val.strip())
    return found


def short(key):
    """`<<"launch", s1>>` as `launch s1`, `<<"sweep">>` as `sweep`."""
    return re.sub(r'[<>"]', "", key).replace(", ", " ")


def main():
    steps = []  # (number, action, {var: raw value})
    current = None
    var = None
    for line in sys.stdin:
        line = line.rstrip("\n")
        step = STEP.match(line)
        if step:
            current = (int(step.group(1)), step.group(2), {})
            steps.append(current)
            var = None
            continue
        if current is None:
            continue
        assign = ASSIGN.match(line)
        if assign:
            var = assign.group(1)
            current[2][var] = assign.group(2)
        elif var is not None and line.startswith("  "):
            current[2][var] += " " + line.strip()
        else:
            var = None
    if not steps:
        print("trace.py: no trace in the input (did the row hold?)", file=sys.stderr)
        return 1
    state = {}
    for number, action, assigned in steps:
        changes = []
        for name, raw in assigned.items():
            new = entries(raw)
            old = state.get(name)
            if isinstance(new, dict):
                old = old if isinstance(old, dict) else {}
                for key, val in new.items():
                    if old.get(key) != val:
                        changes.append(f"{name}[{short(key)}] {old.get(key, '?')} -> {val}")
                state[name] = {**old, **new}
            else:
                if old != new:
                    changes.append(f"{name} {old if old is not None else '?'} -> {new}")
                state[name] = new
        if number == 1:
            print(f"{number:>3}  Init")
        else:
            print(f"{number:>3}  {action}: " + ("; ".join(changes) if changes else "(no change)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
