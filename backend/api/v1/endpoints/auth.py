import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from backend.core.deps import DBSessionDep, require_admin, get_current_user
from backend.core.security import create_token_pair
from backend.core.rate_limit import rate_limit
from backend.schemas.auth import (
    Token, LoginInput, RefreshTokenInput, PasswordResetRequest, 
    PasswordReset, ChangePassword, ResetPasswordWithToken, UserProfile
)
from backend.schemas.user import UserOut, AdminRegister, MemberRegister, AdminCreateUser
from backend.services.auth_service import AuthService
from backend.services.email_service import EmailService
from backend.core.config import settings

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/check-admin")
async def check_admin(db: DBSessionDep):
    """Check if any admin user exists in the system - public endpoint for initial setup"""
    auth_service = AuthService(db)
    admin_exists = await auth_service.check_admin_exists()
    
    # Check if super admin exists without exposing the email address
    super_admin_user = await auth_service.get_user_by_email(settings.SUPER_ADMIN_EMAIL)
    
    return {
        "admin_exists": admin_exists,
        "super_admin_exists": super_admin_user is not None,
        "super_admin_active": super_admin_user.is_active if super_admin_user else False
    }


@router.post("/login", response_model=Token, dependencies=[Depends(rate_limit(max_requests=5, window_seconds=60))])
async def login(db: DBSessionDep, login_data: LoginInput):
    """Login endpoint - accepts email and password"""
    auth_service = AuthService(db)
    user = await auth_service.authenticate_user(email=login_data.email, password=login_data.password)
    
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    
    # Use create_token_pair with remember_me=True for 24h access + 30 day refresh (persistent session)
    remember_me = getattr(login_data, 'remember_me', True)
    tokens = create_token_pair(user.id, remember_me=remember_me)
    
    # Check if user needs to change password - handle case where column might not exist yet
    try:
        requires_change = user.requires_password_change if hasattr(user, 'requires_password_change') else False
    except (AttributeError, KeyError):
        requires_change = False
    
    response_data = {
        "access_token": tokens["access_token"],
        "token_type": "bearer",
        "expires_in": tokens["expires_in"],
        "refresh_token": tokens["refresh_token"],
        "requires_password_change": requires_change
    }

    # Daily contract-renewal guard: ensures the renewal pass runs at least
    # once per day even if the background scheduler is down. Idempotent and
    # never raises — safe to call on every successful login.
    from backend.services.contract_renewal_guard import ContractRenewalGuard
    await ContractRenewalGuard().ensure_daily_renewal_ran(db)

    return response_data


@router.post("/token", response_model=Token, dependencies=[Depends(rate_limit(max_requests=5, window_seconds=60))])
async def login_access_token(db: DBSessionDep, form_data: OAuth2PasswordRequestForm = Depends()):
    """OAuth2 compatible login endpoint"""
    auth_service = AuthService(db)
    user = await auth_service.authenticate_user(email=form_data.username, password=form_data.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    tokens = create_token_pair(user.id, remember_me=True)
    return {
        "access_token": tokens["access_token"],
        "token_type": "bearer",
        "expires_in": tokens["expires_in"],
        "refresh_token": tokens["refresh_token"],
    }


@router.post("/register-admin", response_model=UserOut)
async def register_admin(db: DBSessionDep, admin_data: AdminRegister, current_admin = Depends(require_admin())):
    """Register new admin - Admin only"""
    user = await AuthService(db).register_admin(
        email=admin_data.email,
        full_name=admin_data.full_name,
        password=admin_data.password
    )
    return user


@router.post("/register-super-admin", response_model=UserOut, dependencies=[Depends(rate_limit(max_requests=3, window_seconds=60))])
async def register_super_admin(db: DBSessionDep, admin_data: AdminRegister):
    """Register super admin - Only allowed if no admin exists (initial setup)"""
    # Check if any admin exists
    auth_service = AuthService(db)
    admin_exists = await auth_service.check_admin_exists()
    
    # Only allow if no admin exists (initial setup)
    if admin_exists:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Super admin registration is only allowed for initial setup."
        )
    
    user = await auth_service.register_admin(
        email=admin_data.email,
        full_name=admin_data.full_name,
        password=admin_data.password
    )
    return user


@router.post("/register-member", response_model=UserOut)
async def register_member(db: DBSessionDep, member_data: MemberRegister, current_admin = Depends(require_admin())):
    """Register new member - only accessible by admin"""
    user = await AuthService(db).register_member(
        email=member_data.email,
        full_name=member_data.full_name,
        password=member_data.password,
        group_id=member_data.group_id
    )
    return user


@router.post("/admin/create-user", response_model=UserOut)
async def admin_create_user(db: DBSessionDep, user_data: AdminCreateUser, current_admin = Depends(require_admin())):
    """Create a new user by admin - temporary password will be generated and sent via email"""
    from backend.core.security import generate_temporary_password
    
    auth_service = AuthService(db)
    
    # Generate temporary password
    temp_password = generate_temporary_password()
    
    # Create the user with temporary password
    user = await auth_service.register(
        email=user_data.email,
        full_name=user_data.full_name,
        password=temp_password,  # Use generated temporary password
        role=user_data.role,
        group_id=None,  # Remove group_id requirement
        email_verified=True  # Admin-created users are considered verified
    )
    
    # Mark user as needing password change
    try:
        user.requires_password_change = True
        await auth_service.users.update(user)
    except Exception as e:
        logger = logging.getLogger(__name__)
        logger.warning(f"Could not set requires_password_change flag: {e}")
    
    # Create password reset token for initial password setup
    from backend.core.security import create_initial_password_reset_token
    reset_token = create_initial_password_reset_token(user.id, expires_days=7)
    
    logger = logging.getLogger(__name__)
    email_service = EmailService()
    email_sent = await email_service.send_user_credentials_email(
        email=user_data.email,
        full_name=user_data.full_name,
        password=temp_password,  # Send temporary password
        role=user_data.role,
        reset_token=reset_token  # Include reset token for password change link
    )
    
    if not email_sent:
        logger.warning(f"Failed to send credentials email to {user_data.email}. User was created but email was not sent.")
    
    return user


@router.post("/refresh", response_model=Token)
async def refresh_token(db: DBSessionDep, refresh_data: RefreshTokenInput):
    """Refresh access token using refresh token"""
    from backend.core.security import decode_token, create_token_pair
    
    payload = decode_token(refresh_data.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token"
        )
    
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user_id = int(sub)
    auth_service = AuthService(db)
    user = await auth_service.get_user_by_id(user_id)

    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive"
        )
    
    return create_token_pair(user_id, remember_me=True)  # Keep persistent session on refresh


@router.post("/logout")
async def logout():
    """Logout endpoint - client should remove tokens"""
    return {"message": "Successfully logged out"}


@router.post("/forgot-password", dependencies=[Depends(rate_limit(max_requests=3, window_seconds=60))])
async def forgot_password(db: DBSessionDep, request: PasswordResetRequest, background_tasks: BackgroundTasks):
    """Request password reset"""
    auth_service = AuthService(db)
    user = await auth_service.get_user_by_email(request.email)

    # Only issue a reset for active accounts. The email is dispatched as a
    # background task so the response returns in constant time regardless of
    # whether the account exists — otherwise the SMTP round-trip would create a
    # timing side-channel that leaks which emails are registered.
    if user and user.is_active:
        expires_minutes = 30
        reset_token = await auth_service.create_password_reset_token(user.email, expires_minutes=expires_minutes)
        email_service = EmailService()
        background_tasks.add_task(
            email_service.send_password_reset_email,
            email=user.email,
            full_name=user.full_name,
            reset_token=reset_token,
            validity_text=f"{expires_minutes} דקות",
        )

    # Always return success to prevent email enumeration
    return {"message": "If the email exists, a reset link has been sent"}


@router.post("/reset-password", dependencies=[Depends(rate_limit(max_requests=5, window_seconds=60))])
async def reset_password(db: DBSessionDep, reset_data: PasswordReset):
    """Reset password using reset token"""
    from backend.core.security import verify_password_reset_token
    
    email = verify_password_reset_token(reset_data.token)
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token"
        )
    
    auth_service = AuthService(db)
    user = await auth_service.get_user_by_email(email)

    # Inactive/archived accounts get the same response as unknown ones
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User not found"
        )

    await auth_service.update_password(user.id, reset_data.new_password)
    return {"message": "Password updated successfully"}


@router.post("/reset-password-with-token")
async def reset_password_with_token(
    db: DBSessionDep,
    reset_data: ResetPasswordWithToken
):
    """Reset password using token and temporary password verification"""
    from backend.core.security import (
        verify_initial_password_reset_token,
        verify_password_reset_token,
        verify_password,
    )

    auth_service = AuthService(db)

    # Accept both token types that land on the /reset-password page:
    #  - initial_password_reset (keyed by user id) for admin-created accounts
    #  - password_reset (keyed by email) for the forgot-password flow
    user = None
    user_id = verify_initial_password_reset_token(reset_data.token)
    if user_id:
        user = await auth_service.users.get_by_id(user_id)
    else:
        email = verify_password_reset_token(reset_data.token)
        if email:
            user = await auth_service.get_user_by_email(email)

    # Inactive/archived accounts get the same response as an invalid token
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired token"
        )
    
    # Verify temporary password only if provided
    if reset_data.temp_password:
        if not verify_password(reset_data.temp_password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Temporary password is incorrect"
            )
    
    # Update password
    await auth_service.update_password(user.id, reset_data.new_password)
    
    # Clear requires_password_change flag
    if hasattr(user, 'requires_password_change'):
        user.requires_password_change = False
        await auth_service.users.update(user)
    
    return {"message": "Password updated successfully"}


@router.post("/change-password")
async def change_password(
    db: DBSessionDep, 
    password_data: ChangePassword, 
    current_user = Depends(get_current_user)
):
    """Change password for authenticated user"""
    auth_service = AuthService(db)
    
    # Get user from database to check requires_password_change flag
    user = await auth_service.users.get_by_id(current_user.id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # If user requires password change, skip current password verification
    requires_change = getattr(user, 'requires_password_change', False)
    
    if not requires_change:
        # Verify current password only if not required to change
        if not auth_service.verify_password(password_data.current_password, current_user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password is incorrect"
            )
    else:
        # For required password change, verify the temporary password
        if not auth_service.verify_password(password_data.current_password, current_user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Temporary password is incorrect"
            )
    
    await auth_service.update_password(user.id, password_data.new_password)
    
    # Clear requires_password_change flag after successful password change
    if requires_change:
        user.requires_password_change = False
        await auth_service.users.update(user)
    
    return {"message": "Password updated successfully"}


@router.get("/profile", response_model=UserProfile)
async def get_profile(db: DBSessionDep, current_user = Depends(get_current_user)):
    """Get current user profile with enhanced information"""
    return UserProfile(
        id=current_user.id,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        is_active=current_user.is_active,
        created_at=current_user.created_at,
        group_id=getattr(current_user, "group_id", None),
        phone=getattr(current_user, "phone", None),
        avatar_url=getattr(current_user, "avatar_url", None),
        calendar_color=getattr(current_user, "calendar_color", None),
        calendar_date_display=getattr(current_user, "calendar_date_display", "gregorian") or "gregorian",
        show_jewish_holidays=getattr(current_user, "show_jewish_holidays", True),
        show_islamic_holidays=getattr(current_user, "show_islamic_holidays", False),
    )
