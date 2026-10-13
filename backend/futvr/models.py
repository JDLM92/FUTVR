from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import math


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Vec2(StrictModel):
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)

    @field_validator("x", "y")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Coordinates must be finite")
        return value


Team = Literal["a", "b", "unknown", "official"]


class Actor(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    role: Literal["player", "ball", "official"]
    team: Team
    position: Vec2
    name: str | None = Field(default=None, max_length=100)
    label: str | None = Field(default=None, max_length=20)
    number: str | None = Field(default=None, max_length=8)
    provenance: Literal["automatic", "manual", "sample"]
    imagePoint: Vec2 | None = None
    needsReview: bool | None = None


class Annotation(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    kind: Literal["arrow", "line", "circle", "zone", "label"]
    start: Vec2
    end: Vec2
    color: str = Field(max_length=30)
    text: str | None = Field(default=None, max_length=500)


class Keyframe(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    durationMs: int = Field(ge=100, le=60_000)
    holdMs: int = Field(ge=0, le=60_000)
    positions: dict[str, Vec2]
    annotations: list[Annotation] = Field(max_length=200)


class Landmark(StrictModel):
    image: Vec2
    pitch: Vec2

    @field_validator("image")
    @classmethod
    def normalized(cls, value: Vec2) -> Vec2:
        if not (0 <= value.x <= 1 and 0 <= value.y <= 1):
            raise ValueError("Image coordinates must be normalized to 0..1")
        return value


class Calibration(StrictModel):
    status: Literal["estimated", "confirmed", "manual", "unavailable"]
    matrix: list[float] | None = Field(default=None, min_length=9, max_length=9)
    landmarks: list[Landmark] | None = Field(default=None, max_length=50)

    @field_validator("matrix")
    @classmethod
    def finite_matrix(cls, value):
        if value is not None and not all(math.isfinite(x) for x in value):
            raise ValueError("Matrix must be finite")
        return value


class Pitch(StrictModel):
    length: float = Field(ge=90, le=120)
    width: float = Field(ge=45, le=90)


class Crop(StrictModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class Source(StrictModel):
    type: Literal["image"]
    url: str = Field(max_length=4000)
    width: int = Field(gt=0, le=24_000)
    height: int = Field(gt=0, le=24_000)
    crop: Crop
    assetId: str | None = Field(default=None, max_length=120)
    timestampMs: int | None = Field(default=None, ge=0)


class Scene(StrictModel):
    schemaVersion: Literal[1]
    id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=160)
    revision: int = Field(ge=0)
    pitch: Pitch
    source: Source | None = None
    calibration: Calibration
    actors: list[Actor] = Field(max_length=60)
    keyframes: list[Keyframe] = Field(min_length=1, max_length=30)
    createdAt: datetime
    updatedAt: datetime

    @model_validator(mode="after")
    def stable_ids(self):
        ids = [actor.id for actor in self.actors]
        if len(set(ids)) != len(ids):
            raise ValueError("Actor IDs must be unique")
        frame_ids = [frame.id for frame in self.keyframes]
        if len(set(frame_ids)) != len(frame_ids):
            raise ValueError("Keyframe IDs must be unique")
        for frame in self.keyframes:
            if not set(frame.positions).issubset(ids):
                raise ValueError("Keyframe positions refer to unknown actors")
        for actor in self.actors:
            if not (0 <= actor.position.x <= self.pitch.length and 0 <= actor.position.y <= self.pitch.width):
                raise ValueError("Actor positions must be on the pitch")
            if actor.imagePoint and not (0 <= actor.imagePoint.x <= 1 and 0 <= actor.imagePoint.y <= 1):
                raise ValueError("Image coordinates must be normalized to 0..1")
        for frame in self.keyframes:
            if any(not (0 <= point.x <= self.pitch.length and 0 <= point.y <= self.pitch.width) for point in frame.positions.values()):
                raise ValueError("Keyframe actor positions must be on the pitch")
        return self


class SaveDraft(StrictModel):
    scene: Scene
    expectedRevision: int = Field(ge=0)


class PublishRequest(StrictModel):
    includeSource: bool = False


class CommentAnchor(StrictModel):
    actorId: str | None = Field(default=None, max_length=120)
    point: Vec2 | None = None
    timeMs: int = Field(ge=0)


class AddComment(StrictModel):
    body: str = Field(min_length=1, max_length=2000)
    anchor: CommentAnchor
    parentId: str | None = Field(default=None, max_length=120)

    @field_validator("body")
    @classmethod
    def strip_body(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Comment cannot be blank")
        return value.strip()


class CalibrationRequest(StrictModel):
    landmarks: list[Landmark] = Field(min_length=4, max_length=50)
    imageWidth: int | None = Field(default=None, gt=0)
    imageHeight: int | None = Field(default=None, gt=0)


class EmailRequest(StrictModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def email_shape(cls, value: str) -> str:
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Enter a valid email address")
        local, domain = value.split("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Enter a valid email address")
        return value


class VerifyRequest(EmailRequest):
    code: str = Field(min_length=6, max_length=12, pattern=r"^[0-9]+$")
    guestToken: str | None = Field(default=None, max_length=4000)


class AssetView(StrictModel):
    id: str
    url: str
    width: int
    height: int
    expiresAt: datetime


class AnalysisDetection(StrictModel):
    id: str
    role: Literal["player", "ball", "official"]
    team: Team
    imagePoint: Vec2
    needsReview: bool
    box: list[float] | None = Field(default=None, min_length=4, max_length=4)


class AnalysisResult(StrictModel):
    detections: list[AnalysisDetection]
    calibration: Calibration
    notice: str | None = None


class AnalysisJob(StrictModel):
    id: str
    status: Literal["queued", "processing", "completed", "failed"]
    stage: str | None = None
    error: str | None = None
    result: AnalysisResult | None = None
    asset: AssetView | None = None


class Publication(StrictModel):
    id: str
    scene: Scene
    ownerId: str
    createdAt: datetime
    includeSource: bool


class Comment(StrictModel):
    id: str
    publicationId: str
    parentId: str | None = None
    author: str
    authorId: str
    body: str
    anchor: CommentAnchor
    createdAt: datetime


class RefreshRequest(StrictModel):
    refreshToken: str = Field(min_length=1, max_length=4000)
