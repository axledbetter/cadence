# Cadence v8.2.0 launch demo
#
# Renders to GIF + MP4 via VHS by Charmbracelet:
#   brew install charmbracelet/tap/vhs
#   vhs marketing/demo.tape
#
# Outputs:
#   - marketing/demo.gif (X-friendly, looping)
#   - marketing/demo.mp4 (higher-quality, for X/embeds)
#
# Target length: ~30-40 sec at default playback.
#
# Design note: this tape uses standard unix tools (cat, ls, gh) instead
# of the cadence CLI directly because VHS subprocesses don't always
# inherit the same PATH/env as the operator's shell. The files it shows
# are the REAL files that ship in the npm tarball — `cat examples/specs/
# node-cli.md` reads the exact spec template a `cadence examples node`
# call would print.

Output marketing/demo.gif
Output marketing/demo.mp4

# Window sizing for X (16:9, 1200x700 reads well at twitter compression)
Set FontSize 18
Set Width 1200
Set Height 700
Set Padding 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# Clean prompt setup (Hide+Show suppresses these from recording)
Env PS1 "$ "
Hide
Type "cd ~/work/claude-autopilot"
Enter
Type "clear"
Enter
Sleep 200ms
Show

# Beat 1: title card (~2 sec)
Type "# cadence — autonomous dev pipeline for Claude Code"
Sleep 2s
Enter
Sleep 500ms

# Beat 2: install + version (~3 sec)
Type "# npm install -g @delegance/cadence"
Sleep 1500ms
Enter
Type "cadence --version"
Enter
Sleep 2s

# Beat 3: ship templates available out of the box (~4 sec)
Type "ls examples/specs/"
Enter
Sleep 4s

# Beat 4: peek at one of them — what a real spec looks like (~6 sec)
Type "head -20 examples/specs/node-cli.md"
Enter
Sleep 6s

# Beat 5: clear screen, set up receipts beat
Hide
Type "clear"
Enter
Sleep 200ms
Show

# Beat 6: cadence ships itself — show recently merged PRs (~7 sec)
Type "# every release was shipped by cadence itself:"
Enter
Sleep 1s
Type "gh pr list --repo axledbetter/cadence --state merged --limit 5"
Enter
Sleep 7s

# Beat 7: closing CTA (~3 sec)
Enter
Type "# github.com/axledbetter/cadence"
Sleep 3s
