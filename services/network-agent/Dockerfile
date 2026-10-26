FROM python:3.12-slim
WORKDIR /agent
COPY requirements.txt .
# --progress-bar off: a barra de progresso usa uma thread, que o Docker < 20.10.10 nega a imagens Debian recentes
RUN pip install --no-cache-dir --progress-bar off --require-hashes -r requirements.txt && pip check
COPY nexo_agent nexo_agent
COPY tests tests
RUN useradd -u 10001 -m agent && mkdir -p /data && chown agent /data
USER agent
ENV NEXO_AGENT_DATA=/data PYTHONUNBUFFERED=1
CMD ["python", "-m", "nexo_agent"]
