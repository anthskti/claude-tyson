BG = (22, 26, 32)
CARD = (34, 40, 48)
TEXT = (240, 243, 248)
MUTED = (163, 174, 187)
GREEN = (122, 222, 143)
AMBER = (104, 205, 255)
RED = (132, 140, 255)


def _wrap(text, width, scale=.48):
    import cv2
    lines, current = [], ''
    for word in str(text).split():
        candidate = (current+' '+word).strip()
        if current and cv2.getTextSize(candidate, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0] > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    return lines+[current] if current else lines
