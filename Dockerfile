# AI Design 2D — image cho deploy
FROM python:3.11-slim

# rembg/onnxruntime cần vài thư viện hệ thống
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# copy code + model + mockup (bỏ .env, gallery qua .dockerignore)
COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["python", "server.py"]
