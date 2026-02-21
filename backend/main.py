from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from bson import ObjectId
from datetime import datetime
import os

from database import students_col, teachers_col
from models import StudentRegister, StudentLogin, TeacherLogin
from auth import hash_password, verify_password, create_access_token
from quiz import router as quiz_router

app = FastAPI(title="AI-Proctored Quiz API", version="1.0.0")

# ─── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Include Quiz Routes ───────────────────────────────────────────────────────
app.include_router(quiz_router)


# ─── Student Auth ─────────────────────────────────────────────────────────────
@app.post("/student/register")
async def student_register(payload: StudentRegister):
    existing = await students_col.find_one({"university_number": payload.university_number})
    if existing:
        raise HTTPException(status_code=400, detail="University number already registered")

    email_check = await students_col.find_one({"email": payload.email})
    if email_check:
        raise HTTPException(status_code=400, detail="Email already in use")

    doc = {
        "university_number": payload.university_number,
        "name": payload.name,
        "email": payload.email,
        "password": hash_password(payload.password),
        "created_at": datetime.utcnow().isoformat(),
    }
    await students_col.insert_one(doc)
    return {"message": "Student registered successfully"}


@app.post("/student/login")
async def student_login(payload: StudentLogin):
    student = await students_col.find_one({"university_number": payload.university_number})
    if not student or not verify_password(payload.password, student["password"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"sub": student["university_number"], "role": "student", "name": student["name"]})
    return {"access_token": token, "role": "student", "name": student["name"], "university_number": student["university_number"]}


# ─── Teacher Auth ─────────────────────────────────────────────────────────────
@app.post("/teacher/login")
async def teacher_login(payload: TeacherLogin):
    teacher = await teachers_col.find_one({"email": payload.email})
    if not teacher or not verify_password(payload.password, teacher["password"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"sub": str(teacher["_id"]), "role": "teacher", "name": teacher["name"]})
    return {"access_token": token, "role": "teacher", "name": teacher["name"]}


# ─── Seed default teacher (run once) ─────────────────────────────────────────
@app.on_event("startup")
async def seed_teacher():
    existing = await teachers_col.find_one({"email": "admin@quiz.com"})
    if not existing:
        await teachers_col.insert_one({
            "name": "Admin Teacher",
            "email": "admin@quiz.com",
            "password": hash_password("admin123"),
        })
        print("[OK] Default teacher seeded: admin@quiz.com / admin123")

    # Create indexes
    await students_col.create_index("university_number", unique=True)
    await students_col.create_index("email", unique=True)
    print("[OK] Indexes created")


@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


# ─── Serve Frontend ───────────────────────────────────────────────────────────
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=os.path.join(frontend_path, "js")), name="js")

    @app.get("/", include_in_schema=False)
    async def serve_index():
        return FileResponse(os.path.join(frontend_path, "login.html"))
