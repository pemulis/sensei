// This code should call a guide's prompt endpoint and return a result.
function callGuide(name) {
  console.log("Calling the guide called " + name + "...")
  if (name === "secret-word-example") {
    return "The secret word is 'cat'.";
  } else if (name === "secret-number-example") {
    return "The secret number is 34.";
  }
}

module.exports = callGuide;