FROM python:3.12-slim
COPY page.html /page.html
COPY server.py /server.py
USER nobody
WORKDIR /app
CMD ["python", "/server.py"]
