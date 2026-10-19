import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router-dom";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
};

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, prefetch: _prefetch, scroll: _scroll, replace, ...props }, ref) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) || props.download) {
    return <a ref={ref} href={href} {...props} />;
  }
  return <RouterLink ref={ref} to={href} replace={replace} preventScrollReset={_scroll === false} {...props} />;
});

export default Link;
