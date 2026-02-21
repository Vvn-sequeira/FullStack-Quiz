from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List, Dict
from datetime import datetime


# ─── Student ───────────────────────────────────────────────────────────────────
class StudentRegister(BaseModel):
    university_number: str
    name: str
    email: EmailStr
    password: str


class StudentLogin(BaseModel):
    university_number: str
    password: str


# ─── Teacher ───────────────────────────────────────────────────────────────────
class TeacherLogin(BaseModel):
    email: EmailStr
    password: str


# ─── Quiz ──────────────────────────────────────────────────────────────────────
class QuizCreate(BaseModel):
    title: str
    duration_minutes: int


class QuestionCreate(BaseModel):
    question_text: str
    option_a: str
    option_b: str
    option_c: str
    option_d: str
    correct_option: str  # "A" | "B" | "C" | "D"


# ─── Submission ────────────────────────────────────────────────────────────────
class QuizSubmit(BaseModel):
    answers: Dict[str, str]   # { question_id: "A" | "B" | "C" | "D" }
    started_at: str           # ISO datetime string
    force_fail: Optional[bool] = False


class ViolationReport(BaseModel):
    violation_type: str       # "tab_switch" | "fullscreen_exit" | "noise"
