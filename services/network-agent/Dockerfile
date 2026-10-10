FROM python:3.12-slim
WORKDIR /agent
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY nexo_agent nexo_agent
COPY tests tests
RUN useradd -u 10001 -m agent && mkdir -p /data && chown agent /data
USER agent
ENV NEXO_AGENT_DATA=/data PYTHONUNBUFFERED=1
CMD ["python", "-m", "nexo_agent"]
