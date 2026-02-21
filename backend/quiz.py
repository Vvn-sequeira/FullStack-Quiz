from fastapi import APIRouter, HTTPException, Depends, Header
from typing import Optional
from bson import ObjectId
from datetime import datetime
import httpx
import random
import string

from database import quizzes_col, questions_col, attempts_col, students_col
from models import QuizCreate, QuestionCreate, QuizSubmit, ViolationReport
from auth import decode_token

router = APIRouter()

EMAIL_SERVICE_URL = "http://localhost:3001/send-result"


# ─── Helpers ──────────────────────────────────────────────────────────────────
def str_id(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc["_id"] = str(doc["_id"])
    return doc


def generate_access_code() -> str:
    """Generate a short unique code like QZ-A3X9K2"""
    chars = string.ascii_uppercase + string.digits
    code = ''.join(random.choices(chars, k=6))
    return f"QZ-{code}"


async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    token = authorization.split(" ")[1]
    try:
        return decode_token(token)
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


async def require_teacher(user=Depends(get_current_user)):
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Teachers only")
    return user


async def require_student(user=Depends(get_current_user)):
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="Students only")
    return user


# ─── Quiz CRUD ─────────────────────────────────────────────────────────────────
@router.post("/quiz/create")
async def create_quiz(payload: QuizCreate, user=Depends(require_teacher)):
    # Generate a unique access code (ensure no collisions)
    access_code = generate_access_code()
    while await quizzes_col.find_one({"access_code": access_code}):
        access_code = generate_access_code()

    doc = {
        "title": payload.title,
        "duration_minutes": payload.duration_minutes,
        "created_by": user["sub"],
        "created_at": datetime.utcnow().isoformat(),
        "access_code": access_code,
    }
    result = await quizzes_col.insert_one(doc)
    return {
        "quiz_id": str(result.inserted_id),
        "access_code": access_code,
        "message": "Quiz created"
    }


@router.get("/quiz/list")
async def list_quizzes(user=Depends(get_current_user)):
    """Teachers see full list with access codes. Students cannot use this."""
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Students must use a quiz access code to join a quiz.")
    quizzes = []
    async for q in quizzes_col.find():
        quizzes.append(str_id(q))
    return {"quizzes": quizzes}


@router.get("/quiz/titles")
async def list_quiz_titles(user=Depends(get_current_user)):
    """Public quiz titles list for leaderboard dropdown — no access codes exposed."""
    quizzes = []
    async for q in quizzes_col.find({}, {"title": 1}):
        quizzes.append({"_id": str(q["_id"]), "title": q["title"]})
    return {"quizzes": quizzes}


@router.get("/quiz/by-code/{code}")
async def get_quiz_by_code(code: str, user=Depends(require_student)):
    """Student enters access code → gets quiz_id to start the quiz"""
    quiz = await quizzes_col.find_one({"access_code": code.upper().strip()})
    if not quiz:
        raise HTTPException(status_code=404, detail="Invalid quiz code. Please ask your teacher for the correct code.")
    return {
        "quiz_id": str(quiz["_id"]),
        "title": quiz["title"],
        "duration_minutes": quiz["duration_minutes"],
    }


@router.post("/quiz/{quiz_id}/add-question")
async def add_question(quiz_id: str, payload: QuestionCreate, user=Depends(require_teacher)):
    if not ObjectId.is_valid(quiz_id):
        raise HTTPException(status_code=400, detail="Invalid quiz ID")
    quiz = await quizzes_col.find_one({"_id": ObjectId(quiz_id)})
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    doc = {
        "quiz_id": quiz_id,
        "question_text": payload.question_text,
        "options": {
            "A": payload.option_a,
            "B": payload.option_b,
            "C": payload.option_c,
            "D": payload.option_d,
        },
        "correct_option": payload.correct_option.upper(),
    }
    result = await questions_col.insert_one(doc)
    return {"question_id": str(result.inserted_id), "message": "Question added"}


@router.get("/quiz/{quiz_id}/questions")
async def get_questions(quiz_id: str, user=Depends(get_current_user)):
    if not ObjectId.is_valid(quiz_id):
        raise HTTPException(status_code=400, detail="Invalid quiz ID")
    quiz = await quizzes_col.find_one({"_id": ObjectId(quiz_id)})
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")

    qs = []
    async for q in questions_col.find({"quiz_id": quiz_id}):
        doc = str_id(q)
        # Hide correct_option from students
        if user.get("role") == "student":
            doc.pop("correct_option", None)
        qs.append(doc)

    return {
        "quiz_id": quiz_id,
        "title": quiz["title"],
        "duration_minutes": quiz["duration_minutes"],
        "questions": qs,
    }


@router.get("/quiz/{quiz_id}/detail")
async def get_quiz_detail(quiz_id: str, user=Depends(require_teacher)):
    if not ObjectId.is_valid(quiz_id):
        raise HTTPException(status_code=400, detail="Invalid quiz ID")
    quiz = await quizzes_col.find_one({"_id": ObjectId(quiz_id)})
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    qs = []
    async for q in questions_col.find({"quiz_id": quiz_id}):
        qs.append(str_id(q))
    quiz = str_id(quiz)
    quiz["questions"] = qs
    return quiz


# ─── Violations ────────────────────────────────────────────────────────────────
@router.post("/quiz/{quiz_id}/violation")
async def report_violation(quiz_id: str, payload: ViolationReport, user=Depends(require_student)):
    univ = user["sub"]
    attempt = await attempts_col.find_one({"student_university_number": univ, "quiz_id": quiz_id})

    # __init__ sentinel: create attempt if not exists (called at quiz start)
    if payload.violation_type == "__init__":
        if not attempt:
            await attempts_col.insert_one({
                "student_university_number": univ,
                "quiz_id": quiz_id,
                "answers": {},
                "score": 0,
                "violation_count": 0,
                "violations": [],
                "status": "IN_PROGRESS",
                "started_at": datetime.utcnow().isoformat(),
                "submitted_at": None,
            })
        return {"violation_count": 0, "status": "IN_PROGRESS"}

    # Must have an active attempt
    if not attempt or attempt.get("status") not in ("IN_PROGRESS", None):
        raise HTTPException(status_code=404, detail="No active attempt found")

    new_count = attempt.get("violation_count", 0) + 1
    update = {"$set": {"violation_count": new_count}, "$push": {"violations": payload.violation_type}}

    # Tab switch = immediate FAIL
    if payload.violation_type == "tab_switch" or new_count > 1:
        update["$set"]["status"] = "FAILED"
        update["$set"]["submitted_at"] = datetime.utcnow().isoformat()

    await attempts_col.update_one({"_id": attempt["_id"]}, update)
    updated = await attempts_col.find_one({"_id": attempt["_id"]})
    return {"violation_count": updated["violation_count"], "status": updated["status"]}


# ─── Submit ────────────────────────────────────────────────────────────────────
@router.post("/quiz/{quiz_id}/submit")
async def submit_quiz(quiz_id: str, payload: QuizSubmit, user=Depends(require_student)):
    univ = user["sub"]

    # Check for existing attempt
    existing = await attempts_col.find_one({"student_university_number": univ, "quiz_id": quiz_id})
    if existing and existing.get("status") in ("PASSED", "FAILED"):
        raise HTTPException(status_code=400, detail="Quiz already submitted")

    # Get current violation count
    violation_count = existing.get("violation_count", 0) if existing else 0

    # Force fail (tab close / timer expire with violations)
    if payload.force_fail:
        score = 0
        status = "FAILED"
    else:
        # Score calculation
        all_questions = []
        async for q in questions_col.find({"quiz_id": quiz_id}):
            all_questions.append(q)

        correct = 0
        for q in all_questions:
            qid = str(q["_id"])
            if payload.answers.get(qid, "").upper() == q["correct_option"].upper():
                correct += 1

        score = correct
        total = len(all_questions)

        status = "PASSED" if (score >= total * 0.5 and violation_count <= 1) else "FAILED"

    submitted_at = datetime.utcnow().isoformat()

    attempt_doc = {
        "student_university_number": univ,
        "quiz_id": quiz_id,
        "answers": payload.answers,
        "score": score if not payload.force_fail else 0,
        "violation_count": violation_count,
        "status": status,
        "started_at": payload.started_at,
        "submitted_at": submitted_at,
    }

    if existing:
        await attempts_col.update_one({"_id": existing["_id"]}, {"$set": attempt_doc})
        attempt_id = existing["_id"]
    else:
        result = await attempts_col.insert_one(attempt_doc)
        attempt_id = result.inserted_id

    # Leaderboard rank
    rank = await compute_rank(quiz_id, univ)

    # Get student info for email
    student = await students_col.find_one({"university_number": univ})

    # Fire email async (non-blocking)
    if student:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(EMAIL_SERVICE_URL, json={
                    "to": student["email"],
                    "name": student["name"],
                    "university_number": univ,
                    "score": attempt_doc["score"],
                    "status": status,
                    "violation_count": violation_count,
                    "rank": rank,
                    "quiz_title": (await quizzes_col.find_one({"_id": ObjectId(quiz_id)}))["title"],
                })
        except Exception:
            pass  # Email failure doesn't block submission

    return {
        "score": attempt_doc["score"],
        "status": status,
        "violation_count": violation_count,
        "rank": rank,
        "submitted_at": submitted_at,
    }


# ─── Leaderboard ───────────────────────────────────────────────────────────────
async def compute_rank(quiz_id: str, univ: str) -> int:
    rank = 1
    async for a in attempts_col.find({"quiz_id": quiz_id, "status": {"$in": ["PASSED", "FAILED"]}}):
        if a["student_university_number"] == univ:
            continue
        # Higher score = better rank
        if a.get("score", 0) > 0:
            try:
                a_time = (datetime.fromisoformat(a["submitted_at"]) - datetime.fromisoformat(a["started_at"])).seconds
                rank += 1
            except Exception:
                rank += 1
    return rank


@router.get("/quiz/{quiz_id}/leaderboard")
async def leaderboard(quiz_id: str, user=Depends(get_current_user)):
    attempts = []
    async for a in attempts_col.find({"quiz_id": quiz_id, "status": {"$in": ["PASSED", "FAILED"]}}):
        student = await students_col.find_one({"university_number": a["student_university_number"]})
        try:
            time_taken = (
                datetime.fromisoformat(a["submitted_at"]) - datetime.fromisoformat(a["started_at"])
            ).seconds
        except Exception:
            time_taken = 99999

        attempts.append({
            "name": student["name"] if student else "Unknown",
            "university_number": a["student_university_number"],
            "score": a.get("score", 0),
            "status": a.get("status", "—"),
            "violation_count": a.get("violation_count", 0),
            "time_taken_seconds": time_taken,
        })

    # Sort: score DESC, then time ASC
    attempts.sort(key=lambda x: (-x["score"], x["time_taken_seconds"]))
    for i, a in enumerate(attempts):
        a["rank"] = i + 1

    return {"leaderboard": attempts}


# ─── Attempts (Admin) ──────────────────────────────────────────────────────────
@router.get("/quiz/{quiz_id}/attempts")
async def get_attempts(quiz_id: str, user=Depends(require_teacher)):
    result = []
    async for a in attempts_col.find({"quiz_id": quiz_id}):
        student = await students_col.find_one({"university_number": a["student_university_number"]})
        a = str_id(a)
        a["student_name"] = student["name"] if student else "Unknown"
        a["student_email"] = student["email"] if student else "—"
        result.append(a)
    return {"attempts": result}
