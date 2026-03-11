FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

# Expose port
EXPOSE 8080

# Start with Gunicorn (WebSocket supported worker)
CMD gunicorn -k eventlet -w 1 -b 0.0.0.0:$PORT --timeout 120 app:app
