bind_socket = "0.0.0.0:11332";
milter = yes;
timeout = 60s;
count = 1;
upstream "local" {
  default = yes;
  self_scan = yes;
}
