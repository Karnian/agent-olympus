export function greet(user) {
  const name = user?.name ? user.name : 'guest';
  return `HELLO, ${name.toUpperCase()}`;
}
