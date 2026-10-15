# Sourced by start.sh, terminal.sh and card-terminal.sh: load .env, but never override a variable that is already
# set in the environment (the same rule server.js follows). Handles KEY=value, optional quotes, comments, blank lines.
if [ -f .env ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in ''|'#'*) continue ;; esac
    _key="${_line%%=*}"; _val="${_line#*=}"
    [[ "$_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$_val" in \"*\") _val="${_val%\"}"; _val="${_val#\"}" ;; \'*\') _val="${_val%\'}"; _val="${_val#\'}" ;; esac
    if [ -z "${!_key+x}" ]; then export "$_key=$_val"; fi
  done < .env
  unset _line _key _val
fi
