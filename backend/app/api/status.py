from fastapi import APIRouter, Depends

from ..config import Settings, get_settings
from ..connectors.cloudflare.d1 import D1Client
from ..services.acquisition.status import AcquisitionStatusService

router = APIRouter(tags=["status"])


@router.get("/status")
async def acquisition_status(settings: Settings = Depends(get_settings)):
    service = AcquisitionStatusService(D1Client(settings))
    return await service.active()
