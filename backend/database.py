from motor.motor_asyncio import AsyncIOMotorClient
import os
from dotenv import load_dotenv

load_dotenv()

MONGO_URL = os.getenv("MONGO_URL", "mongodb+srv://svivianmarcel_db_user:iDxbr8cQ52N8DGBc@srinivashackpack.atwefuv.mongodb.net/?appName=SrinivasHackPack")

client = AsyncIOMotorClient(MONGO_URL)
db = client["quiz_app"]

# Collections
students_col = db["students"]
teachers_col = db["teachers"]
quizzes_col = db["quizzes"]
questions_col = db["questions"]
attempts_col = db["quiz_attempts"]
