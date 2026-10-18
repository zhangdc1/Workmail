FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends rspamd ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY local.d /etc/rspamd/local.d
COPY override.d /etc/rspamd/override.d
RUN rspamadm configtest
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["rspamd","-f","-u","_rspamd","-g","_rspamd"]
