from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from authlib.integrations.httpx_client import AsyncOAuth2Client
from typing import Optional

from backend.core.config import settings
from backend.core.security import create_token_pair
from backend.repositories.user_repository import UserRepository
from backend.models.user import User, UserRole


class OAuthService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.users = UserRepository(db)
        self.google_client = AsyncOAuth2Client(
            client_id=settings.GOOGLE_CLIENT_ID,
            client_secret=settings.GOOGLE_CLIENT_SECRET,
            scope="openid email profile",
        )

    async def get_google_authorization_url(self, state: Optional[str] = None) -> str:
        """Get Google OAuth authorization URL"""
        if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Google OAuth is not configured"
            )
        
        authorization_url, _ = await self.google_client.create_authorization_url(
            url="https://accounts.google.com/o/oauth2/v2/auth",
            redirect_uri=settings.GOOGLE_REDIRECT_URI,
            state=state
        )
        return authorization_url

    async def handle_google_callback(self, code: str, state: Optional[str] = None) -> dict:
        """Handle Google OAuth callback and create/login user"""
        try:
            # Exchange code for token
            token = await self.google_client.fetch_token(
                url="https://oauth2.googleapis.com/token",
                grant_type="authorization_code",
                code=code,
                redirect_uri=settings.GOOGLE_REDIRECT_URI
            )

            # Get user info from Google
            user_info = await self.google_client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                token=token
            )
            user_data = user_info.json()

            email = user_data.get("email")
            oauth_id = user_data.get("id")
            full_name = user_data.get("name", "")
            avatar_url = user_data.get("picture")
            email_verified = user_data.get("verified_email", False)

            if not email or not oauth_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to get user information from Google"
                )

            # Check if user exists by email
            user = await self.users.get_by_email(email)
            
            if user:
                # User exists - check if OAuth is linked
                if user.oauth_provider == "google" and user.oauth_id == oauth_id:
                    # OAuth login successful
                    if not user.is_active:
                        raise HTTPException(
                            status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="User account is inactive"
                        )
                    # Update user info
                    user.avatar_url = avatar_url
                    user.email_verified = email_verified or user.email_verified
                    await self.users.update(user)
                    tokens = create_token_pair(user.id, remember_me=True)
                    return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "token_type": "bearer", "expires_in": tokens["expires_in"], "user": user}
                elif user.password_hash:
                    # User exists with password - ask to link accounts
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="An account with this email already exists. Please login with your password first, or use a different Google account."
                    )
                else:
                    # Link OAuth to existing account
                    if not user.is_active:
                        raise HTTPException(
                            status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="User account is inactive"
                        )
                    user.oauth_provider = "google"
                    user.oauth_id = oauth_id
                    user.avatar_url = avatar_url
                    user.email_verified = email_verified or user.email_verified
                    await self.users.update(user)
                    tokens = create_token_pair(user.id, remember_me=True)
                    return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "token_type": "bearer", "expires_in": tokens["expires_in"], "user": user}
            else:
                # New user - create account
                new_user = User(
                    email=email,
                    full_name=full_name,
                    password_hash=None,
                    oauth_provider="google",
                    oauth_id=oauth_id,
                    email_verified=email_verified,
                    avatar_url=avatar_url,
                    role=UserRole.MEMBER.value,
                    is_active=True
                )
                created_user = await self.users.create(new_user)
                tokens = create_token_pair(created_user.id, remember_me=True)
                return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "token_type": "bearer", "expires_in": tokens["expires_in"], "user": created_user}

        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"OAuth authentication failed: {str(e)}"
            )
