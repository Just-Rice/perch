//! `roost --selftest`: quick checks that the parts work on this PC (the encoder, Opus, the key map, input planning,
//! and on Windows the displays, capture and sound), printed one per line. Exit 0 when all pass.
use crate::media::{h264::H264, opus::AudioPipeline, synthetic, yuv::I420};

pub fn run() -> i32 {
    let mut failed = 0;
    let mut check = |name: &str, r: Result<String, String>| match r {
        Ok(detail) => println!("ok   {name}{}", if detail.is_empty() { String::new() } else { format!(" ({detail})") }),
        Err(e) => { failed += 1; println!("FAIL {name}: {e}"); }
    };
    check("key map covers every required key", {
        let missing: Vec<String> = crate::keymap::required().into_iter().filter(|c| crate::keymap::lookup(c).is_none()).collect();
        if missing.is_empty() { Ok(String::new()) } else { Err(missing.join(", ")) }
    });
    check("input planning", if crate::app::selftest_input() { Ok(String::new()) } else { Err("a click didn't plan a move and a press".into()) });
    check("H.264 encoder", (|| {
        let mut e = H264::new(1280, 720, 30, 3000, None)?;
        let mut pic = I420::new(1280, 720);
        synthetic::draw(&mut pic, 0, None);
        let t = std::time::Instant::now();
        let f = e.encode(&pic, true, 0)?.ok_or("no first frame")?;
        if !f.keyframe { return Err("the first frame isn't a keyframe".into()); }
        Ok(format!("{} bytes, {} ms", f.annex_b.len(), t.elapsed().as_millis()))
    })());
    check("Opus encoder", (|| {
        let mut p = AudioPipeline::new()?;
        let mut n = 0;
        p.feed(&synthetic::Tone::default().next(1920), 0, |_, _| n += 1);
        if n == 2 { Ok(String::new()) } else { Err(format!("{n} packets for 40 ms")) }
    })());
    for (name, r) in crate::sys::selftest() { check(&name, r); }
    if failed == 0 { println!("all checks passed"); 0 } else { 1 }
}
