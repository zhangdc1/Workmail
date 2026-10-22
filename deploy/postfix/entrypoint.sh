#!/bin/sh
set -eu
: "${MAIL_HOSTNAME:?}" "${POSTFIX_PASSWORD:?}"
case "$MAIL_HOSTNAME" in *[!a-zA-Z0-9.-]*|'') echo "Invalid mail hostname"; exit 1;; esac
cert="/etc/letsencrypt/live/$MAIL_HOSTNAME"
test -s "$cert/fullchain.pem" && test -s "$cert/privkey.pem" || { echo "先通过 certbot 获取 SMTP 证书，再启动 mail profile"; exit 1; }
umask 077
for map in domains recipients; do
  if [ "$map" = domains ]; then query="SELECT 1 FROM postfix_domains WHERE name='%s'"; else query="SELECT 1 FROM postfix_recipients WHERE address='%s'"; fi
  printf 'hosts = postgres\nuser = postfix\npassword = %s\ndbname = inboxlab\nquery = %s\n' "$POSTFIX_PASSWORD" "$query" > "/etc/postfix/pgsql-$map.cf"
  chgrp postfix "/etc/postfix/pgsql-$map.cf"; chmod 640 "/etc/postfix/pgsql-$map.cf"
done
postconf -e "myhostname = $MAIL_HOSTNAME" "mydestination = localhost" "inet_interfaces = all" "inet_protocols = ipv4"
postconf -e "mynetworks = 127.0.0.0/8" "smtpd_relay_restrictions = reject_unauth_destination" "smtpd_recipient_restrictions = reject_non_fqdn_recipient, reject_unlisted_recipient"
postconf -e "relay_domains = pgsql:/etc/postfix/pgsql-domains.cf" "relay_recipient_maps = pgsql:/etc/postfix/pgsql-recipients.cf" "relay_transport = smtp:[smtp]:2525"
postconf -e "smtpd_sasl_auth_enable = no" "disable_vrfy_command = yes" "smtpd_helo_required = yes" "smtpd_reject_unlisted_recipient = yes" "recipient_delimiter ="
postconf -e "message_size_limit = 10485760" "smtpd_recipient_limit = 20" "smtp_destination_concurrency_limit = 4"
postconf -e "smtpd_tls_security_level = may" "smtpd_tls_cert_file = $cert/fullchain.pem" "smtpd_tls_key_file = $cert/privkey.pem" "smtpd_tls_protocols = >=TLSv1.2" "smtpd_tls_loglevel = 1"
postconf -e "smtp_tls_security_level = none" "smtpd_milters = inet:rspamd:11332" "non_smtpd_milters =" "milter_protocol = 6" "milter_default_action = tempfail"
postconf -e "maillog_file = /dev/stdout" "compatibility_level = 3.6" "smtputf8_enable = no" "maximal_queue_lifetime = 5d" "bounce_queue_lifetime = 1d"
# Disable chroot for every service, including trivial-rewrite, which performs
# relay-domain SQL lookups and needs Docker DNS/libpq outside the spool.
postconf -F '*/*/chroot=n'
postconf -M 'smtp/inet=smtp inet n - n - - smtpd'
postconf -M 'relay/unix=relay unix - - n - - smtp'
postconf -M 'smtp/unix=smtp unix - - n - - smtp'
postfix set-permissions
postfix check
(
  old=$(sha256sum "$cert/fullchain.pem")
  while sleep 300; do
    new=$(sha256sum "$cert/fullchain.pem")
    if [ "$new" != "$old" ]; then postfix reload; old="$new"; fi
  done
) &
exec postfix start-fg
