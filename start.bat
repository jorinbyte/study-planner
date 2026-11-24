@echo off
title StudyFlow - Bachelor Study Planner
echo Starting StudyFlow server on http://127.0.0.1:8080 ...
start "" http://127.0.0.1:8080
py server.py || python server.py
pause
