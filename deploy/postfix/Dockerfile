FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && echo "postfix postfix/mailname string localhost" | debconf-set-selections && echo "postfix postfix/main_mailer_type string Internet Site" | debconf-set-selections && apt-get install -y --no-install-recommends postfix postfix-pgsql ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/inboxlab-postfix
RUN chmod +x /usr/local/bin/inboxlab-postfix
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/inboxlab-postfix"]
