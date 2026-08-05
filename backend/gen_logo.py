"""One-shot logo generation for Meribaari app."""
import asyncio, os, base64, sys
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from emergentintegrations.llm.chat import LlmChat, UserMessage

PROMPT = """Create a modern, minimalist mobile app icon for a healthcare queue management app called "Meribaari" (Hindi for "my turn"). Design requirements:
- Square 1:1 icon, iOS/Android app-icon style with soft rounded-corner container
- Bold flat design, no photo-realism
- Central visual: a stylized queue/waiting-line concept combined with a medical cross OR a large token number "1" in circle, giving a sense of "your turn is here"
- Color palette: primary deep sky blue #0369A1 gradient to lighter #0EA5E9, with white or bright accent
- Optional small heartbeat/pulse line or subtle wait-time dots
- Very clean, professional, trustworthy healthcare feel
- No text/typography inside the icon (just the visual mark)
- Filled edge-to-edge (no white padding around) suitable for app icon
- Sharp, high-contrast, works at small sizes"""

async def main():
    api_key = os.getenv("EMERGENT_LLM_KEY")
    chat = LlmChat(api_key=api_key, session_id="meribaari-logo", system_message="You are an expert brand designer.")
    chat.with_model("gemini", "gemini-3.1-flash-image-preview").with_params(modalities=["image", "text"])
    msg = UserMessage(text=PROMPT)
    text, images = await chat.send_message_multimodal_response(msg)
    print(f"Text: {text[:200] if text else '(none)'}")
    if not images:
        print("NO IMAGES RETURNED")
        sys.exit(1)
    out = "/app/frontend/assets/images/icon.png"
    with open(out, "wb") as f:
        f.write(base64.b64decode(images[0]["data"]))
    print(f"Saved to {out} ({os.path.getsize(out)} bytes, mime={images[0]['mime_type']})")

asyncio.run(main())
