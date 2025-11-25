// Quick test harness for link detection in engage.js

const extractUsernameFromXLink = (url) => {
  if (!url) return null;
  const match = url.match(/(?:https?:\/\/)?(?:www\.)?x\.com\/([^\s\/]+)/i) ||
                url.match(/(?:https?:\/\/)?(?:www\.)?twitter\.com\/([^\s\/]+)/i);
  return match ? match[1] : null;
};

const isXLink = (text) => {
  return !!extractUsernameFromXLink(text);
};

const tests = [
  'https://x.com/username',
  'http://x.com/username',
  'x.com/username',
  'www.x.com/username',
  'https://twitter.com/username',
  'twitter.com/username',
  'some random text with x.com/username somewhere',
  'text with x.com/ that is not a username',
  'this is x.com but not following slash',
  'just some random x and twitter.com without username',
  'https://x.com/username?param=value',
  'x.com/username/subpath',
  'not a link x.com/',
  'Check me @x.com/username',
  'not link but contains x.com/ and nothing else',
];

console.log('Test results for extractUsernameFromXLink and isXLink:');
for (const t of tests) {
  console.log(`\nInput: ${t}`);
  console.log(`isXLink: ${isXLink(t)}`);
  console.log(`extract: ${extractUsernameFromXLink(t)}`);
}
