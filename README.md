# StudyFlow — Bachelor Study Planner & Gemini AI Companion

A zero-dependency local web app built for bachelor students to track assignments & upcoming tests, submit completed work (and edit courses/tests even after submission), auto-generate tasks, themes, and time-budgeted subtasks from uploaded course documents, view a full Chart Overview, and leverage a rate-limited Gemini AI backend.

## Features

- **Assignments & Upcoming Tests Tracker**: Organize by course, due date countdowns, priority, grade weight, progress bars, and full post-submission editing of both courses and tests.
- **Upload Course Document → Auto-Build Tasks, Themes & Subtasks**: Upload lecture slides/scripts (`PDF`, `PPTX`, `DOCX`, `MD`, `TXT`, `PNG`, `JPG`) and enter **how much time you have left** — Gemini automatically extracts course themes, creates tasks, and budgets chapter subtasks to fit your time left.
- **Per-Subtask AI Explanations & Practice Tests**: Generate bachelor-level explanations or interactive multiple-choice + short-answer practice tests (with automated grading & feedback) on every chapter/subtask.
- **General Chart Overview**: Built-in SVG & CSS charts showing your 14-day upcoming workload vs. daily target, task status donut, study workload per course, estimated vs. actual time accuracy, and practice test score history.
- **AI Overview of All Lectures & Themes**: Synthesize all courses, chapters, deadlines, time estimates, and attached documents into core themes, lecture takeaways, likely exam questions, and a prioritized study plan.
- **Dynamic Gemini Models, Visible Retries & Rate Limit Guard**: Fetch the newest models directly from Google's API in **Settings**, automatically retry with a live countdown banner if Gemini servers are busy, and enforce a configurable **Max Requests / Minute (RPM)** and **Daily Safety Cap**.

---

## Install on Raspberry Pi 5 (Port 8080, Visible on Local Network)

StudyFlow uses **only Python 3 standard library** — no `pip`, `node`, or Docker required, and minimal RAM usage.

1. **Copy or clone** this repository onto your Raspberry Pi 5:
   ```bash
   git clone <your-repo-url> ~/study-planner
   cd ~/study-planner
   ```
2. **Run the installer** (sets up a `systemd` service on `0.0.0.0:8080` that starts automatically on boot and opens UFW port `8080/tcp` if UFW is active):
   ```bash
   chmod +x install-pi.sh
   sudo ./install-pi.sh
   ```
3. **Open from any device on your Wi-Fi / LAN** (laptop, tablet, or phone):
   - `http://<raspberry-pi-ip>:8080` (printed by the installer)
   - or `http://raspberrypi.local:8080` (using your Pi's hostname)

### Raspberry Pi Service Commands

```bash
# Check status
sudo systemctl status studyflow

# View live logs
sudo journalctl -u studyflow -f

# Update after git pull
git pull && sudo systemctl restart studyflow

# Uninstall (keeps your data/ folder by default; add --purge to remove data too)
sudo ./uninstall-pi.sh
```

---

## Running Manually (Windows / Linux / macOS)

Requires **Python 3.10+** (zero external packages needed).

- **Windows**: Double-click `start.bat` or run:
  ```powershell
  py server.py
  ```
- **Linux / macOS / Pi (manual foreground)**:
  ```bash
  ./start.sh
  # or
  python3 server.py --host 0.0.0.0 --port 8080
  ```

Then open **http://127.0.0.1:8080** locally (or `http://<your-lan-ip>:8080` from another device on your network).

All data is stored locally in `data/study_planner.db` and `data/uploads/`.
