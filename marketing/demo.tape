# Cadence v8.2.0 launch demo (tier-1 polish)
#
# Renders the CORE terminal beat. Title + outro cards are composited
# in post via ffmpeg (see marketing/render.sh).
#
#   vhs marketing/demo.tape    # produces marketing/demo-core.{gif,mp4}
#   bash marketing/render.sh   # composites title + core + outro + watermark

Output marketing/demo-core.gif
Output marketing/demo-core.mp4

# Tier-1 polish settings
Set FontFamily "Menlo"
Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 40
Set Theme "TokyoNight"
Set TypingSpeed 35ms
Set PlaybackSpeed 1.5

# Clean prompt setup (Hide+Show suppresses these from recording)
Env PS1 "$ "
Hide
Type "cd ~/work/claude-autopilot"
Enter
Type "clear"
Enter
Sleep 200ms
Show

# Beat 1: install (~2 sec)
Type "# npm install -g @delegance/cadence"
Sleep 1500ms
Enter
Type "cadence --version"
Enter
Sleep 1500ms

# Beat 2: ship templates available out of the box (~3 sec)
Type "ls examples/specs/"
Enter
Sleep 3s

# Beat 3: peek at one of them — what a real spec looks like (~4 sec)
Type "head -15 examples/specs/node-cli.md"
Enter
Sleep 4s

# Beat 4: clear screen, set up receipts beat
Hide
Type "clear"
Enter
Sleep 200ms
Show

# Beat 5: cadence ships itself — show recently merged PRs (~5 sec)
Type "# every release was shipped by cadence itself:"
Enter
Sleep 1s
Type "gh pr list --repo axledbetter/cadence --state merged --limit 5"
Enter
Sleep 5s
