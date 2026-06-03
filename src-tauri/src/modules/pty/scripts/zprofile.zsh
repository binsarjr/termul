# termul-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _termul_user_zdotdir="${TERMUL_USER_ZDOTDIR:-$HOME}"
  [ -f "$_termul_user_zdotdir/.zprofile" ] && source "$_termul_user_zdotdir/.zprofile"
  unset _termul_user_zdotdir
}
:
