//! sd-wrap: the terminal sync wrapper as its own console program (`sd-wrap claude …`). On Windows it
//! must be one: the app is a GUI program, which a shell neither waits for nor gives its console. It
//! uses only the small sdwrap crate, so it starts fast and links none of the app's GUI libraries.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(sdwrap::run(&args));
}
